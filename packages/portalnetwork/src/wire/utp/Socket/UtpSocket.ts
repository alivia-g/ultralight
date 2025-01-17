import { BitArray, BitVectorType } from '@chainsafe/ssz'

import { bitmap } from '../../../index.js'
import { PacketManager } from '../Packets/PacketManager.js'
import { ConnectionState, PacketType, UtpSocketType, randUint16 } from '../index.js'

import { ContentReader } from './ContentReader.js'
import { ContentWriter } from './ContentWriter.js'

import type { NetworkId } from '../../../index.js'
import type {
  ICreateData,
  ICreatePacketOpts,
  Packet,
  PortalNetworkUTP,
  UtpSocketOptions,
} from '../index.js'
import type { Debugger } from 'debug'

export class UtpSocket {
  utp: PortalNetworkUTP
  networkId: NetworkId
  type: UtpSocketType
  content: Uint8Array
  remoteAddress: string
  protected seqNr: number
  ackNr: number
  finNr: number | undefined
  sndConnectionId: number
  rcvConnectionId: number
  state: ConnectionState | null
  writer: ContentWriter | undefined
  reader: ContentReader | undefined
  readerContent: Uint8Array | undefined
  ackNrs: (number | undefined)[]
  received: number[]
  expected: number[]
  logger: Debugger
  packetManager: PacketManager
  throttle: () => void
  updateDelay: (timestamp: number, timeReceived: number) => void
  updateRTT: (packetRTT: number, ackNr: number) => void
  updateWindow: () => void
  constructor(options: UtpSocketOptions) {
    this.utp = options.utp
    this.networkId = options.networkId
    this.content = options.content ?? Uint8Array.from([])
    this.remoteAddress = options.remoteAddress
    this.rcvConnectionId = options.rcvId
    this.sndConnectionId = options.sndId
    this.seqNr = options.seqNr
    this.ackNr = options.ackNr
    this.finNr = undefined
    this.state = null
    this.readerContent = new Uint8Array()
    this.type = options.type
    this.ackNrs = []
    this.received = []
    this.expected = []
    this.logger = options.logger
      .extend(`${this.type}Socket`)
      .extend(this.rcvConnectionId.toString())
    this.packetManager = new PacketManager(options.rcvId, options.sndId, this.logger)
    this.throttle = () => this.packetManager.congestionControl.throttle()
    this.updateDelay = (timestamp: number, timeReceived: number) =>
      this.packetManager.congestionControl.updateDelay(timestamp, timeReceived)
    this.updateRTT = (packetRtt: number, ackNr: number) =>
      this.packetManager.congestionControl.updateRTT(packetRtt, ackNr)
    this.updateWindow = () => this.packetManager.updateWindow()
    this.packetManager.congestionControl.on('write', async () => {
      await this.writer?.write()
    })
  }

  setAckNr(ackNr: number) {
    this.ackNr = ackNr
  }

  setSeqNr(seqNr: number) {
    this.seqNr = seqNr
  }

  getSeqNr() {
    return this.seqNr
  }

  setWriter(seqNr: number) {
    this.writer = new ContentWriter(this, this.content, seqNr, this.logger)
    void this.writer.start()
  }
  setState(state: ConnectionState) {
    this.state = state
  }

  setReader(startingSeqNr: number) {
    this.reader = new ContentReader(startingSeqNr, this.logger)
  }

  _clearTimeout() {
    clearTimeout(this.packetManager.congestionControl.timeoutCounter)
  }

  async sendPacket<T extends PacketType>(packet: Packet<T>): Promise<Buffer> {
    const msg = packet.encode()
    this.logger.extend('SEND').extend(PacketType[packet.header.pType])(
      `|| pktId: ${packet.header.connectionId}`,
    )
    this.logger.extend('SEND').extend(PacketType[packet.header.pType])(
      `|| seqNr: ${packet.header.seqNr}`,
    )
    this.logger.extend('SEND').extend(PacketType[packet.header.pType])(
      `|| ackNr: ${packet.header.ackNr}`,
    )
    await this.utp.send(this.remoteAddress, msg, this.networkId)
    return msg
  }

  createPacket<T extends PacketType>(
    opts: ICreatePacketOpts<T> = {} as ICreatePacketOpts<T>,
  ): Packet<T> {
    const extension = 'bitmask' in opts ? 1 : 0
    const params = {
      ...opts,
      seqNr: this.seqNr,
      ackNr: this.ackNr,
      connectionId: opts.connectionId ?? this.rcvConnectionId,
      extension,
    }
    opts.pType === PacketType.ST_DATA && this.seqNr++
    return this.packetManager.createPacket<T>(params)
  }

  async sendSynPacket(pktId?: number): Promise<void> {
    const p = this.createPacket({
      pType: PacketType.ST_SYN,
      connectionId: pktId ?? this.rcvConnectionId,
    })
    this.state = ConnectionState.SynSent
    await this.sendPacket<PacketType.ST_SYN>(p)
  }
  async sendAckPacket(bitmask?: Uint8Array): Promise<void> {
    const packet = bitmask
      ? this.createPacket({ pType: PacketType.ST_STATE, bitmask })
      : this.createPacket({ pType: PacketType.ST_STATE })
    await this.sendPacket<PacketType.ST_STATE>(packet)
  }
  async sendSynAckPacket(): Promise<void> {
    await this.sendAckPacket()
  }
  async sendResetPacket() {
    this.state = ConnectionState.Reset
    const packet = this.createPacket<PacketType.ST_RESET>({ pType: PacketType.ST_RESET })
    await this.sendPacket<PacketType.ST_RESET>(packet)
  }
  async sendFinPacket(): Promise<void> {
    const packet = this.createPacket<PacketType.ST_FIN>({ pType: PacketType.ST_FIN })
    this.finNr = packet.header.seqNr
    await this.sendPacket<PacketType.ST_FIN>(packet)
  }
  async sendDataPacket(bytes: Uint8Array): Promise<void> {
    this.state = ConnectionState.Connected
    try {
      await this.packetManager.congestionControl.canSend()
    } catch (e) {
      this.logger(`DATA packet not acked.  Closing connection to ${this.remoteAddress}`)
      await this.sendResetPacket()
      this.close()
    }
    const packet = this.createPacket<PacketType.ST_DATA>({
      pType: PacketType.ST_DATA,
      payload: bytes,
    } as ICreateData)
    await this.sendPacket<PacketType.ST_DATA>(packet)
    this.packetManager.congestionControl.outBuffer.set(
      packet.header.seqNr,
      packet.header.timestampMicroseconds,
    )
    this.updateWindow()
  }

  async handleSynPacket(seqNr: number): Promise<void> {
    this.setState(ConnectionState.SynRecv)
    this.logger(`Connection State: SynRecv`)
    this.setAckNr(seqNr)
    if (this.type === UtpSocketType.READ) {
      // This initiates an OFFER.
      // The first DATA packet will have seqNr + 1
      this.setReader(seqNr + 1)
      await this.sendSynAckPacket()
    } else {
      // This initiates a FINDCONTENT request.
      // Set a random seqNr and send a SYN-ACK.  Do not increment seqNr.
      // The first DATA packet will have the same seqNr.
      this.setSeqNr(randUint16())
      this.logger(`Setting seqNr to ${this.seqNr}.  Sending SYN-ACK`)
      await this.sendSynAckPacket()
      this.logger(`SYN-ACK sent.  Starting DATA stream.`)
      this.setWriter(this.seqNr)
    }
  }

  async handleFinAck(): Promise<boolean> {
    this.logger(`FIN packet ACKed. Closing Socket.`)
    this.state = ConnectionState.Closed
    this._clearTimeout()
    return true
  }

  async handleStatePacket(ackNr: number, timestamp: number): Promise<void> {
    if (ackNr === this.finNr) {
      await this.handleFinAck()
      return
    }
    if (this.type === UtpSocketType.READ) {
      return
    }
    this.updateAckNrs(ackNr)
    this.updateRTT(timestamp, ackNr)
    this.packetManager.updateWindow()
    this.logProgress()
    if (this.compare()) {
      await this.sendFinPacket()
      return
    }
    await this.writer!.write()
  }

  async handleDataPacket(packet: Packet<PacketType.ST_DATA>): Promise<void | Uint8Array> {
    this._clearTimeout()
    if (this.state !== ConnectionState.GotFin) {
      this.state = ConnectionState.Connected
    } else {
      this.logger(`Connection State: GotFin: ${this.finNr}`)
    }
    let expected = true
    if (this.ackNrs.length > 1) {
      expected = this.ackNr + 1 === packet.header.seqNr
    }
    this.setSeqNr(this.getSeqNr() + 1)
    if (!this.reader) {
      this.reader = new ContentReader(packet.header.seqNr)
      this.reader.bytesExpected = Infinity
    }
    // Add the packet.seqNr to this.ackNrs at the relative index, regardless of order received.
    if (this.ackNrs[0] === undefined) {
      this.logger(`Setting AckNr[0] to ${packet.header.seqNr}`)
      this.ackNrs[0] = packet.header.seqNr
    } else {
      this.logger(
        `Setting AckNr[${packet.header.seqNr - this.ackNrs[0]}] to ${packet.header.seqNr}`,
      )
      this.ackNrs[packet.header.seqNr - this.ackNrs[0]] = packet.header.seqNr
    }
    this.reader.addPacket(packet)
    this.logger(
      `Packet bytes: ${packet.payload!.length} bytes.  Total bytes: ${
        this.reader.bytesReceived
      } bytes.`,
    )
    if (expected) {
      // Update this.ackNr to last in-order seqNr received.
      const future = this.ackNrs.slice(packet.header.seqNr - this.ackNrs[0]!)
      this.ackNr = future.slice(future.findIndex((n, i, ackNrs) => ackNrs[i + 1] === undefined))[0]!
      if (this.state === ConnectionState.GotFin) {
        if (this.ackNr === this.finNr) {
          this.logger(`All data packets received. Running compiler.`)
          await this.sendAckPacket()
          return this.close(true)
        }
      }
      // Send "Regular" ACK with the new this.ackNr
      return this.sendAckPacket()
    } else {
      // Do not increment this.ackNr
      // Send SELECTIVE_ACK with bitmask of received seqNrs > this.ackNr
      this.logger(`Packet has arrived out of order.  Replying with SELECTIVE ACK.`)
      const bitmask = this.generateSelectiveAckBitMask()
      return this.sendAckPacket(bitmask)
    }
  }

  async handleFinPacket(
    packet: Packet<PacketType.ST_FIN>,
    compile?: boolean,
  ): Promise<Uint8Array | undefined> {
    this.state = ConnectionState.GotFin
    if (this.type === UtpSocketType.WRITE) {
      return this.close()
    }
    this.finNr = packet.header.seqNr
    this.reader!.lastDataNr = this.finNr - 1
    this.logger.extend('FIN')(`Connection State: GotFin: ${this.finNr}`)
    const expected = this.ackNr + 1 === packet.header.seqNr
    if (expected) {
      this.logger.extend('FIN')(
        `all data packets received.  ${this.reader?.bytesReceived} bytes received.`,
      )
      this.seqNr = this.seqNr + 1
      this.ackNr = packet.header.seqNr
      await this.sendAckPacket()
      return this.close(compile)
    } else {
      this.logger.extend('FIN')(`Expected: ${this.ackNr + 1} got ${packet.header.seqNr}`)
      // Else wait for all data packets.
      // TODO: Do we ever ACK the FIN packet?  Does our peer care?
      return
    }
  }

  compile(): Uint8Array {
    const _content = this.reader!.bytes
    this.logger.extend('READING')(`Returning ${_content.length} bytes.`)
    return Uint8Array.from(_content)
  }

  compare(): boolean {
    if (!this.ackNrs.includes(undefined) && this.ackNrs.length === this.writer!.dataNrs.length) {
      return true
    }
    return false
  }

  close(compile: boolean = false): Uint8Array | undefined {
    clearInterval(this.packetManager.congestionControl.timeoutCounter)
    this.packetManager.congestionControl.removeAllListeners()
    this._clearTimeout()
    if (compile === true) {
      return this.compile()
    }
  }
  logProgress() {
    const needed = this.writer!.dataNrs.filter((n) => !this.ackNrs.includes(n))
    this.logger(
      `AckNr's received (${this.ackNrs.length}/${
        this.writer!.sentChunks.length
      }): ${this.ackNrs[0]?.toString()}...${
        this.ackNrs.slice(1).length > 3
          ? this.ackNrs.slice(this.ackNrs.length - 3)?.toString()
          : this.ackNrs.slice(1)?.toString()
      }`,
    )
    this.logger(`AckNr's needed (${needed.length}/${
      Object.keys(this.writer!.dataChunks).length
    }): ${needed.slice(0, 3)?.toString()}${
      needed.slice(3)?.length > 0 ? '...' + needed[needed.length - 1] : ''
    }
        `)
  }
  generateSelectiveAckBitMask(): Uint8Array {
    const window = new Array(32).fill(false)
    for (let i = 0; i < 32; i++) {
      if (this.ackNrs.includes(this.ackNr + 1 + i)) {
        window[bitmap[i] - 1] = true
      }
    }
    const bitMask = new BitVectorType(32).serialize(BitArray.fromBoolArray(window))
    return bitMask
  }
  updateAckNrs(ackNr: number) {
    this.ackNrs = Object.keys(this.writer!.dataChunks)
      .filter((n) => parseInt(n) <= ackNr)
      .map((n) => parseInt(n))
  }
}
