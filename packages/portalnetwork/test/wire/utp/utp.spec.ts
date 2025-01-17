import { hexToBytes } from '@ethereumjs/util'
import { randomBytes } from 'crypto'
import debug from 'debug'
import { assert, describe, it } from 'vitest'

import {
  NetworkId,
  Packet,
  PacketType,
  PortalNetwork,
  PortalNetworkUTP,
  RequestCode,
  UtpSocket,
  UtpSocketType,
  createSocketKey,
  encodeWithVariantPrefix,
  randUint16,
  startingNrs,
} from '../../../src/index.js'
import { ContentReader } from '../../../src/wire/utp/Socket/ContentReader.js'
import { ContentWriter } from '../../../src/wire/utp/Socket/ContentWriter.js'

import type { INewRequest } from '../../../src/index.js'

const sampleSize = 50000

describe('uTP Reader/Writer tests', async () => {
  it('content reader and writer (single content stream)', async () => {
    const content = randomBytes(sampleSize)
    const writer = new ContentWriter(UtpSocket.prototype, content, 0, debug('utp:writer'))
    const reader = new ContentReader(0)
    reader.bytesExpected = Infinity
    const contentChunks = writer.chunk()
    assert.exists(writer, 'ContentWriter created')
    assert.exists(reader, 'ContentReader created')
    assert.equal(
      Object.keys(contentChunks).length,
      Math.ceil(sampleSize / 512),
      'ContentWriter chunked',
    )
    assert.equal(
      Object.keys(contentChunks).length,
      Math.ceil(sampleSize / 512),
      'ContentWriter chunked',
    )
    const totalLength = Object.values(contentChunks).reduce((acc, chunk) => acc + chunk.length, 0)
    assert.equal(totalLength, sampleSize, 'ContentWriter chunked all bytes')
    const packets = Object.values(contentChunks).map((chunk, i) => {
      return Packet.fromOpts({
        header: {
          seqNr: i,
          pType: PacketType.ST_DATA,
          version: 1,
          ackNr: 0,
          connectionId: 0,
          extension: 0,
          timestampDifferenceMicroseconds: 0,
          timestampMicroseconds: 0,
          wndSize: 0,
        },
        payload: chunk,
      })
    })
    assert.equal(packets.length, Object.values(contentChunks).length, 'Packets created')
    let sent = 0
    for (const [i, packet] of packets.entries()) {
      reader.addPacket(packet)
      reader.logger(`TEST PACKET: ${i}/${packets.length}`)
      sent++
    }
    assert.equal(sent, packets.length, 'all Packets sent')
    assert.equal(sent, reader.packets.filter((p) => p).length, 'all Packets added')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(reader.bytes.length, sampleSize, 'ContentReader read all bytes')
  })
  it('content reader and writer (multiple content stream)', async () => {
    const contents = Array.from({ length: 10 }, () => randomBytes(sampleSize))
    const content = encodeWithVariantPrefix(contents)
    const writer = new ContentWriter(UtpSocket.prototype, content, 0, debug('utp:writer'))
    const reader = new ContentReader(0)
    const contentChunks = writer.chunk()
    assert.exists(writer, 'ContentWriter created')
    assert.exists(reader, 'ContentReader created')
    assert.equal(
      Object.keys(contentChunks).length,
      Math.ceil(content.length / 512),
      'ContentWriter chunked',
    )
    const totalLength = Object.values(contentChunks).reduce((acc, chunk) => acc + chunk.length, 0)
    assert.equal(totalLength, content.length, 'ContentWriter chunked all bytes')
    const packets = Object.values(contentChunks).map((chunk, i) => {
      return Packet.fromOpts({
        header: {
          seqNr: i,
          pType: PacketType.ST_DATA,
          version: 1,
          ackNr: 0,
          connectionId: 0,
          extension: 0,
          timestampDifferenceMicroseconds: 0,
          timestampMicroseconds: 0,
          wndSize: 0,
        },
        payload: chunk,
      })
    })
    assert.equal(packets.length, Object.values(contentChunks).length, 'Packets created')
    let sent = 0
    for (const [i, packet] of packets.entries()) {
      reader.addPacket(packet)
      reader.logger(`TEST PACKET: ${i}/${packets.length}`)
      sent++
    }
    assert.equal(sent, packets.length, 'all Packets sent')
    assert.equal(sent, reader.packets.filter((p) => p).length, 'all Packets added')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert.equal(reader.bytesReceived, content.length, 'ContentReader read all bytes')
    assert.equal(reader.contents.length, contents.length, 'ContentReader compiled all contents')
    assert.deepEqual(reader.contents, contents, 'ContentReader compiled all bytes')
  })
})

describe('PortalNetworkUTP test', async () => {
  const client = await PortalNetwork.create({ bindAddress: '127.0.0.1' })
  const utp = new PortalNetworkUTP(client)
  it('createPortalNetworkUTPSocket', async () => {
    const networkId = NetworkId.HistoryNetwork
    // connectionId comes from discv5 talkResp message
    const connectionId = randUint16()
    const socketIds = utp.startingIdNrs(connectionId)
    assert.ok(utp, 'PortalNetworkUTP created')
    let socket = utp.createPortalNetworkUTPSocket(
      networkId,
      RequestCode.FOUNDCONTENT_WRITE,
      '0xPeerAddress',
      socketIds[RequestCode.FOUNDCONTENT_WRITE].sndId,
      socketIds[RequestCode.FOUNDCONTENT_WRITE].rcvId,
      Buffer.from('test'),
    )
    assert.ok(socket, 'UTPSocket created by PortalNetworkUTP')
    assert.equal(socket.sndConnectionId, connectionId + 1, 'UTPSocket has correct sndConnectionId')
    assert.equal(socket.rcvConnectionId, connectionId, 'UTPSocket has correct rcvConnectionId')
    assert.equal(socket.remoteAddress, '0xPeerAddress', 'UTPSocket has correct peerId')
    assert.equal(socket.type, UtpSocketType.WRITE, 'UTPSocket has correct requestCode')
    assert.deepEqual(socket.content, Buffer.from('test'), 'UTPSocket has correct content')
    assert.equal(
      socket.ackNr,
      startingNrs[RequestCode.FOUNDCONTENT_WRITE].ackNr,
      'UTPSocket has correct ackNr',
    )
    socket = utp.createPortalNetworkUTPSocket(
      networkId,
      RequestCode.FINDCONTENT_READ,
      '0xPeerAddress',
      socketIds[RequestCode.FINDCONTENT_READ].sndId,
      socketIds[RequestCode.FINDCONTENT_READ].rcvId,
    )
    assert.equal(socket.type, UtpSocketType.READ, 'UTPSocket has correct requestCode')
    assert.equal(socket.sndConnectionId, connectionId, 'UTPSocket has correct sndConnectionId')
    assert.equal(socket.rcvConnectionId, connectionId + 1, 'UTPSocket has correct rcvConnectionId')

    assert.equal(
      socket.getSeqNr(),
      startingNrs[RequestCode.FINDCONTENT_READ].seqNr,
      'UTPSocket has correct seqNr',
    )
    assert.equal(
      socket.ackNr,
      startingNrs[RequestCode.FINDCONTENT_READ].ackNr,
      'UTPSocket has correct ackNr',
    )

    socket = utp.createPortalNetworkUTPSocket(
      networkId,
      RequestCode.OFFER_WRITE,
      '0xPeerAddress',
      socketIds[RequestCode.OFFER_WRITE].sndId,
      socketIds[RequestCode.OFFER_WRITE].rcvId,
      Buffer.from('test'),
    )
    assert.equal(socket.type, UtpSocketType.WRITE, 'UTPSocket has correct requestCode')
    assert.equal(socket.sndConnectionId, connectionId, 'UTPSocket has correct sndConnectionId')
    assert.equal(socket.rcvConnectionId, connectionId + 1, 'UTPSocket has correct rcvConnectionId')

    assert.equal(
      socket.getSeqNr(),
      startingNrs[RequestCode.OFFER_WRITE].seqNr,
      'UTPSocket has correct seqNr',
    )
    socket = utp.createPortalNetworkUTPSocket(
      networkId,
      RequestCode.ACCEPT_READ,
      '0xPeerAddress',
      socketIds[RequestCode.ACCEPT_READ].sndId,
      socketIds[RequestCode.ACCEPT_READ].rcvId,
    )
    assert.equal(socket.type, UtpSocketType.READ, 'UTPSocket has correct requestCode')
    assert.equal(socket.sndConnectionId, connectionId + 1, 'UTPSocket has correct sndConnectionId')
    assert.equal(socket.rcvConnectionId, connectionId, 'UTPSocket has correct rcvConnectionId')
    assert.equal(
      socket.ackNr,
      startingNrs[RequestCode.ACCEPT_READ].ackNr,
      'UTPSocket has correct ackNr',
    )
  })
  it('handleNewRequest', async () => {
    const connectionId = randUint16()
    let params: INewRequest = {
      networkId: NetworkId.HistoryNetwork,
      contentKeys: [randomBytes(33)],
      peerId: '0xPeerAddress',
      connectionId,
      requestCode: RequestCode.FOUNDCONTENT_WRITE,
      contents: [hexToBytes('0x1234')],
    }
    let contentRequest = await utp.handleNewRequest(params)
    let requestKey = createSocketKey(params.peerId, connectionId)
    assert.equal(
      utp.getRequestKey(params.connectionId, params.peerId),
      requestKey,
      'requestKey recoverd from packet info',
    )
    assert.ok(contentRequest, 'contentRequest created')
    assert.ok(utp.openContentRequest.get(requestKey), 'contentRequest added to openContentRequest')
    assert.equal(
      contentRequest.networkId,
      NetworkId.HistoryNetwork,
      'contentRequest has correct networkId',
    )
    assert.equal(
      contentRequest.requestCode,
      RequestCode.FOUNDCONTENT_WRITE,
      'contentRequest has correct requestCode',
    )
    assert.deepEqual(
      contentRequest.contentKeys,
      params.contentKeys,
      'contentRequest has correct contentKeys',
    )
    assert.deepEqual(
      contentRequest.content,
      hexToBytes('0x1234'),
      'contentRequest has correct content',
    )
    assert.equal(contentRequest.socketKey, requestKey, 'contentRequest has correct socketKey')
    assert.equal(
      contentRequest.socket.type,
      UtpSocketType.WRITE,
      'contentRequest has correct socket type',
    )
    assert.deepEqual(
      contentRequest.socket.content,
      hexToBytes('0x1234'),
      'contentRequest socket has correct content',
    )
    utp.closeRequest(params.connectionId, params.peerId)
    assert.notOk(
      utp.openContentRequest.get(requestKey),
      'contentRequest removed from openContentRequest',
    )
    params = { ...params, requestCode: RequestCode.FINDCONTENT_READ, contents: undefined }
    contentRequest = await utp.handleNewRequest(params)
    requestKey = createSocketKey(params.peerId, params.connectionId)
    assert.equal(
      utp.getRequestKey(params.connectionId, params.peerId),
      requestKey,
      'requestKey recoverd from packet info',
    )
    assert.ok(contentRequest, 'contentRequest created')
    assert.ok(utp.openContentRequest.get(requestKey), 'contentRequest added to openContentRequest')
    assert.equal(
      contentRequest.networkId,
      NetworkId.HistoryNetwork,
      'contentRequest has correct networkId',
    )
    assert.equal(
      contentRequest.requestCode,
      RequestCode.FINDCONTENT_READ,
      'contentRequest has correct requestCode',
    )
    assert.deepEqual(
      contentRequest.contentKeys,
      params.contentKeys,
      'contentRequest has correct contentKeys',
    )
    assert.equal(contentRequest.content, undefined, 'contentRequest has correct content')
    assert.equal(contentRequest.socketKey, requestKey, 'contentRequest has correct socketKey')
    assert.equal(
      contentRequest.socket.type,
      UtpSocketType.READ,
      'contentRequest has correct socket type',
    )
    utp.closeRequest(params.connectionId, params.peerId)
    assert.notOk(
      utp.openContentRequest.get(requestKey),
      'contentRequest removed from openContentRequest',
    )
    params = {
      ...params,
      requestCode: RequestCode.OFFER_WRITE,
      contents: [hexToBytes('0x1234')],
    }
    contentRequest = await utp.handleNewRequest(params)
    requestKey = createSocketKey(params.peerId, params.connectionId)
    assert.equal(
      utp.getRequestKey(params.connectionId, params.peerId),
      requestKey,
      'requestKey recoverd from packet info',
    )
    assert.ok(contentRequest, 'contentRequest created')
    assert.ok(utp.openContentRequest.get(requestKey), 'contentRequest added to openContentRequest')
    assert.equal(
      contentRequest.networkId,
      NetworkId.HistoryNetwork,
      'contentRequest has correct networkId',
    )
    assert.equal(
      contentRequest.requestCode,
      RequestCode.OFFER_WRITE,
      'contentRequest has correct requestCode',
    )
    assert.deepEqual(
      contentRequest.contentKeys,
      params.contentKeys,
      'contentRequest has correct contentKeys',
    )
    assert.equal(contentRequest.content, params.contents![0], 'contentRequest has correct content')
    assert.equal(contentRequest.socketKey, requestKey, 'contentRequest has correct socketKey')
    assert.equal(
      contentRequest.socket.type,
      UtpSocketType.WRITE,
      'contentRequest has correct socket type',
    )
    assert.deepEqual(
      contentRequest.socket.content,
      params.contents![0],
      'contentRequest socket has correct content',
    )
    utp.closeRequest(params.connectionId, params.peerId)
    assert.notOk(
      utp.openContentRequest.get(requestKey),
      'contentRequest removed from openContentRequest',
    )
    params = { ...params, requestCode: RequestCode.ACCEPT_READ, contents: undefined }
    contentRequest = await utp.handleNewRequest(params)
    requestKey = createSocketKey(params.peerId, params.connectionId)
    assert.equal(
      utp.getRequestKey(params.connectionId, params.peerId),
      requestKey,
      'requestKey recoverd from packet info',
    )
    assert.ok(contentRequest, 'contentRequest created')
    assert.ok(utp.openContentRequest.get(requestKey), 'contentRequest added to openContentRequest')
    assert.equal(
      contentRequest.networkId,
      NetworkId.HistoryNetwork,
      'contentRequest has correct networkId',
    )
    assert.equal(
      contentRequest.requestCode,
      RequestCode.ACCEPT_READ,
      'contentRequest has correct requestCode',
    )
    assert.deepEqual(
      contentRequest.contentKeys,
      params.contentKeys,
      'contentRequest has correct contentKeys',
    )
    assert.equal(contentRequest.content, undefined, 'contentRequest has correct content')
    assert.equal(contentRequest.socketKey, requestKey, 'contentRequest has correct socketKey')
    assert.equal(
      contentRequest.socket.type,
      UtpSocketType.READ,
      'contentRequest has correct socket type',
    )
    utp.closeRequest(params.connectionId, params.peerId)
    assert.notOk(
      utp.openContentRequest.get(requestKey),
      'contentRequest removed from openContentRequest',
    )
  })
})
