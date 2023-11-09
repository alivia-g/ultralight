import { Debugger } from 'debug'
import {
  NetworkId,
  addRLPSerializedBlock,
  HistoryNetworkContentType,
  fromHexString,
  HistoryNetwork,
  PortalNetwork,
} from 'portalnetwork'
import { middleware, validators } from '../validators.js'

const methods = ['ultralight_store', 'ultralight_addBlockToHistory']

export class ultralight {
  private _client: PortalNetwork
  private _history: HistoryNetwork
  private logger: Debugger

  constructor(client: PortalNetwork, logger: Debugger) {
    this._client = client
    this._history = this._client.networks.get(NetworkId.HistoryNetwork) as HistoryNetwork
    this.logger = logger
    this.methods = middleware(this.methods.bind(this), 0, [])
    this.addContentToDB = middleware(this.addContentToDB.bind(this), 2, [
      [validators.hex],
      [validators.hex],
    ])
    this.addBlockToHistory = middleware(this.addBlockToHistory.bind(this), 2, [
      [validators.blockHash],
      [validators.hex],
    ])
  }
  async methods() {
    return methods
  }
  async addBlockToHistory(params: [string, string]) {
    this.logger(`ultralight_addBlockToHistory request received`)

    const [blockHash, rlpHex] = params
    const network = this._client.networks.get(NetworkId.HistoryNetwork) as never as HistoryNetwork
    try {
      addRLPSerializedBlock(rlpHex, blockHash, network)
      this.logger(`Block ${blockHash} added to content DB`)
      return `Block ${blockHash} added to content DB`
    } catch (err: any) {
      this.logger(`Error trying to load block to DB. ${err.message.toString()}`)
      return `internal error`
    }
  }
  async addContentToDB(params: [string, string]) {
    const [contentKey, value] = params

    const type: number = parseInt(contentKey.slice(0, 4))
    this.logger(
      `ultralight_addContentToDB request received for ${HistoryNetworkContentType[type]} ${contentKey}`,
    )
    try {
      this._history.store(type, '0x' + contentKey.slice(4), fromHexString(value))
      this.logger(`${type} value for 0x${contentKey.slice(4)} added to content DB`)
      return `${type} value for ${contentKey} added to content DB`
    } catch (err: any) {
      this.logger(`Error trying to load content to DB. ${err.message.toString()}`)
      return `Error trying to load content to DB. ${err.message.toString()}`
    }
  }
}
