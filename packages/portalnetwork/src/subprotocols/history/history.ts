import debug, { Debugger } from 'debug'
import {
  ContentMessageType,
  decodeHistoryNetworkContentKey,
  FindContentMessage,
  MessageCodes,
  PortalWireMessageType,
  reassembleBlock,
  RequestCode,
  shortId,
  Witnesses,
  saveReceipts,
  decodeReceipts,
  PortalNetwork,
  FoundContent,
  toHexString,
  ENR,
  fromHexString,
} from '../../index.js'
import { ProtocolId } from '../types.js'
import { ETH } from './eth_module.js'
import { GossipManager } from './gossip.js'
import { BlockHeaderWithProof, EpochAccumulator, HistoryNetworkContentType } from './types.js'
import { BaseProtocol } from '../protocol.js'
import {
  epochIndexByBlocknumber,
  epochRootByBlocknumber,
  epochRootByIndex,
  blockNumberToGindex,
  getContentKey,
} from './util.js'
import {
  createProof,
  Proof,
  ProofType,
  SingleProof,
  SingleProofInput,
} from '@chainsafe/persistent-merkle-tree'
import { Block, BlockHeader } from '@ethereumjs/block'
import { bytesToInt, hexToBytes } from '@ethereumjs/util'

export class HistoryProtocol extends BaseProtocol {
  protocolId: ProtocolId.HistoryNetwork
  protocolName = 'HistoryNetwork'
  logger: Debugger
  ETH: ETH
  gossipManager: GossipManager
  constructor(client: PortalNetwork, nodeRadius?: bigint) {
    super(client, nodeRadius)
    this.protocolId = ProtocolId.HistoryNetwork
    this.logger = debug(this.enr.nodeId.slice(0, 5)).extend('Portal').extend('HistoryNetwork')
    this.ETH = new ETH(this)
    this.gossipManager = new GossipManager(this)
    this.routingTable.setLogger(this.logger)
    client.uTP.on(
      ProtocolId.HistoryNetwork,
      async (contentType: number, hash: string, value: Uint8Array) => {
        await this.store(contentType, hash, value)
      },
    )
  }
  /**
   *
   * @param decodedContentMessage content key to be found
   * @returns content if available locally
   */
  public findContentLocally = async (contentKey: Uint8Array): Promise<Uint8Array> => {
    const value = await this.retrieve(toHexString(contentKey))
    return value ? hexToBytes(value) : hexToBytes('0x')
  }

  public indexBlockhash = async (number: bigint, blockHash: string) => {
    const blockNumber = '0x' + number.toString(16)
    const blockindex = await this.blockIndex()
    blockindex.set(blockNumber, blockHash)
    await this.setBlockIndex(blockindex)
  }

  /**
   * Retrieve a blockheader from the DB by hash
   * @param blockHash the hash of the blockheader sought
   * @param asBytes return the header as RLP encoded bytes or as an @ethereumjs/block BlockHeader
   * @returns the bytes or Blockheader if found or else undefined
   */
  public getBlockHeaderFromDB = async (
    blockHash: Uint8Array,
    asBytes = true,
  ): Promise<Uint8Array | BlockHeader | undefined> => {
    const contentKey = getContentKey(HistoryNetworkContentType.BlockHeader, blockHash)
    const value = await this.retrieve(contentKey)
    const header = value ? BlockHeaderWithProof.deserialize(fromHexString(value)).header : undefined
    return header !== undefined
      ? asBytes
        ? header
        : BlockHeader.fromRLPSerializedHeader(header, { setHardfork: true })
      : undefined
  }

  public getBlockBodyBytes = async (blockHash: Uint8Array): Promise<Uint8Array | undefined> => {
    const contentKey = getContentKey(HistoryNetworkContentType.BlockBody, blockHash)
    const value = await this.retrieve(contentKey)
    return value ? hexToBytes(value) : undefined
  }

  /**
   * Convenience function that implements `getBlockByHash` when block is stored locally
   * @param blockHash the hash of the block sought
   * @param includeTransactions whether to include the full transactions or not
   * @returns a block with or without transactions
   * @throws if the block isn't found in the DB
   */
  public getBlockFromDB = async (
    blockHash: Uint8Array,
    includeTransactions = true,
  ): Promise<Block> => {
    const header = (await this.getBlockHeaderFromDB(blockHash)) as Uint8Array
    if (!header) {
      throw new Error('Block not found')
    }
    const body = await this.getBlockBodyBytes(blockHash)
    if (!body && includeTransactions) {
      throw new Error('Block body not found')
    }
    return reassembleBlock(header, body)
  }

  public validateHeader = async (value: Uint8Array, contentHash: string) => {
    const headerProof = BlockHeaderWithProof.deserialize(value)
    const header = BlockHeader.fromRLPSerializedHeader(headerProof.header, {
      setHardfork: true,
    })
    const proof = headerProof.proof

    if (header.number < 15537393n) {
      // Only check for proof if pre-merge block header
      if (proof.value === null) {
        throw new Error('Received block header without proof')
      }
      try {
        this.verifyInclusionProof(proof.value, contentHash, header.number)
      } catch {
        throw new Error('Received block header with invalid proof')
      }
    }
    this.indexBlockhash(header.number, toHexString(header.hash()))
    this.put(
      this.protocolId,
      getContentKey(HistoryNetworkContentType.BlockHeader, hexToBytes(contentHash)),
      toHexString(value),
    )
  }

  /**
   * Send FINDCONTENT request for content corresponding to `key` to peer corresponding to `dstId`
   * @param dstId node id of peer
   * @param key content key defined by the subprotocol spec
   * @param protocolId subprotocol ID on which content is being sought
   * @returns the value of the FOUNDCONTENT response or undefined
   */
  public sendFindContent = async (dstId: string, key: Uint8Array) => {
    const enr = dstId.startsWith('enr:')
      ? ENR.decodeTxt(dstId)
      : this.routingTable.getWithPending(dstId)?.value
      ? this.routingTable.getWithPending(dstId)?.value
      : this.routingTable.getWithPending(dstId.slice(2))?.value
    if (!enr) {
      this.logger(`No ENR found for ${shortId(dstId)}.  FINDCONTENT aborted.`)
      return
    }
    this.metrics?.findContentMessagesSent.inc()
    const findContentMsg: FindContentMessage = { contentKey: key }
    const payload = PortalWireMessageType.serialize({
      selector: MessageCodes.FINDCONTENT,
      value: findContentMsg,
    })
    this.logger.extend('FINDCONTENT')(`Sending to ${shortId(enr)}`)
    const res = await this.sendMessage(enr, payload, this.protocolId)
    if (res.length === 0) {
      return undefined
    }

    try {
      if (bytesToInt(res.slice(0, 1)) === MessageCodes.CONTENT) {
        this.metrics?.contentMessagesReceived.inc()
        this.logger.extend('FOUNDCONTENT')(`Received from ${shortId(enr)}`)
        const decoded = ContentMessageType.deserialize(res.subarray(1))
        const contentKey = decodeHistoryNetworkContentKey(toHexString(key))
        const contentHash = contentKey.blockHash
        const contentType = contentKey.contentType

        switch (decoded.selector) {
          case FoundContent.UTP: {
            const id = new DataView((decoded.value as Uint8Array).buffer).getUint16(0, false)
            this.logger.extend('FOUNDCONTENT')(`received uTP Connection ID ${id}`)
            await this.handleNewRequest({
              protocolId: this.protocolId,
              contentKeys: [key],
              peerId: dstId,
              connectionId: id,
              requestCode: RequestCode.FINDCONTENT_READ,
              contents: [],
            })
            break
          }
          case FoundContent.CONTENT:
            this.logger(
              `received ${HistoryNetworkContentType[contentType]} content corresponding to ${contentHash}`,
            )
            try {
              await this.store(contentType, contentHash, decoded.value as Uint8Array)
            } catch {
              this.logger('Error adding content to DB')
            }
            break
          case FoundContent.ENRS: {
            this.logger(`received ${decoded.value.length} ENRs`)
            break
          }
        }
        return decoded
      }
    } catch (err: any) {
      this.logger(`Error sending FINDCONTENT to ${shortId(enr)} - ${err.message}`)
    }
  }

  /**
   * Convenience method to add content for the History Network to the DB
   * @param contentType - content type of the data item being stored
   * @param hashKey - hex string representation of blockHash or epochHash
   * @param value - hex string representing RLP encoded blockheader, block body, or block receipt
   * @throws if `blockHash` or `value` is not hex string
   */
  public store = async (
    contentType: HistoryNetworkContentType,
    hashKey: string,
    value: Uint8Array,
  ): Promise<void> => {
    if (contentType === HistoryNetworkContentType.BlockBody) {
      await this.addBlockBody(value, hashKey)
    } else if (contentType === HistoryNetworkContentType.BlockHeader) {
      try {
        await this.validateHeader(value, hashKey)
      } catch (err) {
        this.logger(`Error validating header: ${(err as any).message}`)
      }
    } else {
      this.put(this.protocolId, getContentKey(contentType, hexToBytes(hashKey)), toHexString(value))
    }
    this.emit('ContentAdded', hashKey, contentType, toHexString(value))
    if (this.routingTable.values().length > 0) {
      // Gossip new content to network (except header accumulators)
      this.gossipManager.add(hashKey, contentType)
    }
    this.logger(`${HistoryNetworkContentType[contentType]} added for ${hashKey}`)
  }

  public async saveReceipts(block: Block) {
    this.logger.extend('BLOCK_BODY')(`added for block #${block.header.number}`)
    const receipts = await saveReceipts(block)
    this.store(HistoryNetworkContentType.Receipt, toHexString(block.hash()), receipts)
    return decodeReceipts(receipts)
  }

  public async addBlockBody(value: Uint8Array, hashKey: string, header?: Uint8Array) {
    const _bodyKey = getContentKey(HistoryNetworkContentType.BlockBody, hexToBytes(hashKey))
    if (value.length === 0) {
      // Occurs when `getBlockByHash` called `includeTransactions` === false
      return
    }
    let block: Block | undefined
    try {
      if (header) {
        block = reassembleBlock(header, value)
      } else {
        const headerBytes = (await this.getBlockHeaderFromDB(fromHexString(hashKey))) as Uint8Array
        // Verify we can construct a valid block from the header and body provided
        block = reassembleBlock(headerBytes!, value)
      }
    } catch (err: any) {
      this.logger(`Block Header for ${shortId(hashKey)} not found locally.  Querying network...`)
      block = await this.ETH.getBlockByHash(hashKey, false)
    }
    const bodyContentKey = getContentKey(HistoryNetworkContentType.BlockBody, hexToBytes(hashKey))
    if (block instanceof Block) {
      this.put(this.protocolId, bodyContentKey, toHexString(value))
      // TODO: Decide when and if to build and store receipts.
      //       Doing this here caused a bottleneck when same receipt is gossiped via uTP at the same time.
      // if (block.transactions.length > 0) {
      //   await this.saveReceipts(block)
      // }
    } else {
      this.logger(`Could not verify block content`)
      this.logger(`Adding anyway for testing...`)
      this.put(this.protocolId, bodyContentKey, toHexString(value))
      // TODO: Decide what to do here.  We shouldn't be storing block bodies without a corresponding header
      // as it's against spec
      return
    }
  }

  public generateInclusionProof = async (blockNumber: bigint): Promise<Witnesses> => {
    try {
      const epochHash = epochRootByBlocknumber(blockNumber)
      const epoch = await this.retrieve(
        getContentKey(HistoryNetworkContentType.EpochAccumulator, epochHash!),
      )
      const accumulator = EpochAccumulator.deserialize(hexToBytes(epoch!))
      const tree = EpochAccumulator.value_toTree(accumulator)
      const proofInput: SingleProofInput = {
        type: ProofType.single,
        gindex: blockNumberToGindex(blockNumber),
      }
      const proof = createProof(tree, proofInput) as SingleProof
      return proof.witnesses
    } catch (err: any) {
      throw new Error('Error generating inclusion proof: ' + (err as any).message)
    }
  }

  public verifyInclusionProof(
    witnesses: Uint8Array[],
    blockHash: string,
    blockNumber: bigint,
  ): boolean {
    const target = epochRootByIndex(epochIndexByBlocknumber(blockNumber))
    const proof: Proof = {
      type: ProofType.single,
      gindex: blockNumberToGindex(blockNumber),
      witnesses: witnesses,
      leaf: hexToBytes(blockHash),
    }
    EpochAccumulator.createFromProof(proof, target)
    return true
  }

  public async getStateRoot(blockNumber: bigint) {
    const block = await this.ETH.getBlockByNumber(blockNumber, false)
    if (!block) {
      throw new Error('Block not found')
    }
    return toHexString(block.header.stateRoot)
  }
}
