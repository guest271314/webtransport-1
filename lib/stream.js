import { ReadableStream, WritableStream } from 'node:stream/web'

/**
 * WebTransport stream events
 * @typedef {import('./types').WebTransportStreamEventHandler} WebTransportStreamEventHandler
 * @typedef {import('./types').StreamRecvSignalEvent} StreamRecvSignalEvent
 * @typedef {import('./types').StreamReadEvent} StreamReadEvent
 * @typedef {import('./types').StreamWriteEvent} StreamWriteEvent
 * @typedef {import('./types').StreamResetEvent} StreamResetEvent
 * @typedef {import('./types').StreamNetworkFinishEvent} StreamNetworkFinishEvent
 *
 * @typedef {import('./types').NativeHttp3WTStream} NativeHttp3WTStream
 *
 * @typedef {import('./session').Http3WTSession} Http3WTSession
 *
 * @typedef {import('stream/web').WritableStreamDefaultController} WritableStreamDefaultController
 */

export class Http3WTStream {
  /**
   * @param {object} args
   * @param {NativeHttp3WTStream} args.object
   * @param {Http3WTSession} args.parentobj
   * @param {object} args.transport
   * @param {boolean} args.bidirectional
   * @param {boolean} args.incoming
   */
  constructor(args) {
    this.objint = args.object
    this.objint.jsobj = this
    this.parentobj = args.parentobj
    this.transport = args.transport
    this.bidirectional = args.bidirectional
    this.incoming = args.incoming
    this.closed = false

    /** @type {Promise<void> | null} */
    this.pendingoperation = null
    this.pendingres = null

    /** @type {Promise<void> | null} */
    this.pendingoperationRead = null
    this.pendingresRead = null

    if (this.bidirectional || this.incoming) {
      /** @type {Number} */
      this.incomingbufferfilled = 0
      /** @type {Number} */
      this.incomingbufferreadpos = 0
      if (!this.objint.readbuffer)
        throw new Error('No readbuffer for read stream')
      // @ts-expect-error `getStats` property is missing from ReadableStream
      /** @type {WebTransportReceiveStream} */
      this.readable = new ReadableStream(
        {
          start: (
            /** @type {import("stream/web").ReadableByteStreamController} */ controller
          ) => {
            this.readableController = controller
            this.parentobj.addReceiveStream(this.readable, controller)
            this.objint.startReading()
          },
          pull: async (
            /** @type {import("stream/web").ReadableByteStreamController} */ controller
          ) => {
            if (this.readableclosed) {
              return Promise.resolve()
            }

            /** @type {Uint8Array} */
            if (this.incomingbufferfilled === 0) {
              this.pendingoperationRead = new Promise((resolve, reject) => {
                this.pendingresRead = resolve
              })
              await this.pendingoperationRead
            }
            if (this.incomingbufferfilled === 0) return Promise.resolve()

            this.drainBuffer()
          },
          cancel: (/** @type {{ code: number; }} */ reason) => {
            /** @type {Promise<void>} */
            const promise = new Promise((resolve, reject) => {
              this.cancelres = resolve
            })
            let code = 0
            if (reason && reason.code) {
              if (reason.code < 0) code = 0
              else if (reason.code > 255) code = 255
              else code = reason.code
            }
            this.readableclosed = true
            this.objint.stopSending(code)
            return promise
          },
          type: 'bytes',
          autoAllocateChunkSize: 4096 // lets take this as buffer size
        }
        // TODO fix stretegy
      )
      this.readable.getStats = () => {
        return Promise.resolve({
          timestamp: 0,
          bytesReceived: 0n,
          bytesResd: 0n
        })
      }
    }
    if (this.bidirectional || !this.incoming) {
      // @ts-expect-error `getStats` property is missing from WritableStream
      /** @type {WebTransportSendStream} */
      this.writable = new WritableStream(
        {
          start: (controller) => {
            this.writableController = controller
            this.parentobj.addSendStream(this.writable, controller)
          },
          write: (chunk, controller) => {
            if (this.writableclosed) {
              return Promise.resolve()
            }
            if (chunk instanceof Uint8Array) {
              this.pendingoperation = new Promise((resolve, reject) => {
                this.pendingres = resolve
              })
              const dataprom = this.parentobj.waitForDatagramsSend()
              dataprom.finally(() => {
                this.objint.writeChunk(chunk)
              })
              return this.pendingoperation
            } else {
              console.log('chunk info:', chunk)
              throw new Error('chunk is not of instanceof Uint8Array ')
            }
          },
          close: () => {
            if (this.writableclosed) {
              return Promise.resolve()
            }
            this.objint.streamFinal()
            this.pendingoperation = new Promise((resolve, reject) => {
              this.pendingres = resolve
            })
            return this.pendingoperation
          },
          abort: (reason) => {
            if (this.writableclosed) {
              return new Promise((resolve, reject) => {
                resolve()
              })
            }
            let code = 0
            if (reason && reason.code) {
              if (reason.code < 0) code = 0
              else if (reason.code > 255) code = 255
              else code = reason.code
            }
            /** @type {Promise<void>} */
            const promise = new Promise((resolve, reject) => {
              this.abortres = resolve
            })
            this.objint.resetStream(code)
            return promise
          }
        },
        { highWaterMark: 4 }
      )
      this.writable.getStats = () => {
        return Promise.resolve({
          timestamp: 0,
          bytesWritten: 0n,
          bytesSent: 0n,
          bytesAcknowledged: 0n
        })
      }
    }

    /** @type {(() => void) | null} */
    this.cancelres = null
    /** @type {(() => void) | null} */
    this.pendingres = null
    /** @type {(() => void) | null} */
    this.abortres = null
  }

  drainBuffer() {
    const byob = this.readableController.byobRequest
    // @ts-ignore
    const view = byob?.view
    // @ts-ignore
    if (!(byob?.view instanceof Uint8Array))
      throw new Error('byob view is not a Uint8Array')
    let toread = Math.min(view.byteLength, this.incomingbufferfilled)
    let read = 0
    if (!this.objint.readbuffer)
      throw new Error('No readbuffer in read for read stream')
    if (
      this.incomingbufferreadpos + toread >
      this.objint.readbuffer.byteLength
    ) {
      /** @type {Number} */
      const firstread =
        this.objint.readbuffer.byteLength - this.incomingbufferreadpos
      read += firstread
      toread -= firstread
      const destview = new Uint8Array(
        view.buffer,
        0 + view.byteOffset,
        firstread
      )
      const srcview = new Uint8Array(
        this.objint.readbuffer,
        this.incomingbufferreadpos,
        firstread
      )
      destview.set(srcview)
      this.incomingbufferreadpos = 0
    }
    {
      const destview = new Uint8Array(
        view.buffer,
        read + view.byteOffset,
        toread
      )
      const srcview = new Uint8Array(
        this.objint.readbuffer,
        this.incomingbufferreadpos,
        toread
      )
      destview.set(srcview)
      read += toread
      this.incomingbufferreadpos =
        (this.incomingbufferreadpos + toread) %
        this.objint.readbuffer.byteLength
    }
    // @ts-ignore
    byob.respond(read)
    this.incomingbufferfilled -= read
    this.objint.updateReadPos(read, this.incomingbufferreadpos)
  }

  /**
   * @param {import('./types').StreamRecvSignalEvent} args
   * @returns {void}
   */
  onStreamRecvSignal(args) {
    // console.log('onStreamRecvSignal', args)
    // check if transport is closed
    let parentcleanup = true
    const parentstate = this.parentobj.state
    if (parentstate === 'closed' || parentstate === 'failed') {
      console.log('no parent cleanup as parent was closed or failed')
      parentcleanup = false
    }
    switch (args.nettask) {
      case 'resetStream':
        if (this.readable) {
          if (parentcleanup)
            this.parentobj.removeReceiveStream(
              this.readable,
              this.readableController
            )
          this.readableclosed = true
          this.readableController.error(args.code || 0)
        } else console.log('stopSending without readable')
        break

      case 'stopSending':
        if (this.writable) {
          if (parentcleanup)
            this.parentobj.removeSendStream(
              this.writable,
              this.writableController
            )

          this.writableclosed = true
          this.writableController.error(args.code || 0)
        } else console.log('stopSending wihtout writable')
        break
      default:
        console.log('unhandled onStreamRecvSignal')
    }

    if (this.pendingoperation) {
      const res = this.pendingres
      this.pendingoperation = null
      this.pendingres = null
      if (res != null) {
        res()
      }
    }
    if (this.pendingoperationRead) {
      const res = this.pendingresRead
      this.pendingoperationRead = null
      this.pendingresRead = null
      if (res != null) {
        res()
      }
    }
  }

  /**
   * @param {StreamReadEvent} args
   * @returns {void}
   */
  onStreamRead(args) {
    if (args.buffergrow && !this.readableclosed) {
      this.incomingbufferfilled += args.buffergrow
      // console.log('stream read received', args.data, Date.now())
      if (this.pendingoperationRead) {
        // this.readableController.enqueue(data)
        const res = this.pendingresRead
        this.pendingoperationRead = null
        this.pendingresRead = null
        if (res) res()
      }
      if (
        this.readableController.desiredSize != null &&
        this.readableController.desiredSize < 0
      )
        this.objint.stopReading()
    }
    if (args.fin) {
      if (this.incomingbufferfilled > 0) {
        console.log('Warning buffer filled and we got a fin')
        if (this.pendingoperationRead || this.pendingresRead)
          throw new Error('We have pendingoperationRead and a filled buffer?')

        this.drainBuffer()
      }
      if (this.cancelres) {
        const res = this.cancelres
        this.cancelres = null
        res()
      }
      if (!this.readableclosed) {
        this.readableController.close()
        this.readableclosed = true
      }
    }
  }

  /**
   * @param {StreamWriteEvent} args
   */
  onStreamWrite(args) {
    // we ignore success
    if (this.pendingoperation) {
      const res = this.pendingres
      this.pendingoperation = null
      this.pendingres = null
      if (res != null) {
        res()
      }
    }
  }

  /**
   * @param {StreamResetEvent} args
   */
  onStreamReset(args) {
    if (this.abortres) {
      this.abortres()
      if (this.readable)
        this.parentobj.removeReceiveStream(
          this.readable,
          this.readableController
        )
      if (this.writable)
        this.parentobj.removeSendStream(this.writable, this.writableController)
      this.readableclosed = true
      this.parentobj.removeStreamObj(this)
    }
  }

  /**
   * @param {StreamNetworkFinishEvent} args
   */
  onStreamNetworkFinish(args) {
    // console.log('networkfinish args', args)
    switch (args.nettask) {
      case 'stopSending':
        if (this.cancelres) {
          const res = this.cancelres
          this.cancelres = null
          res()
        }
        this.stopSendingRecv = true
        break
      case 'resetStream':
        if (this.abortres) {
          const res = this.abortres
          this.abortres = null
          res()
        }

        break

      case 'streamFinal':
        if (this.pendingoperation) {
          const res = this.pendingres
          this.pendingoperation = null
          this.pendingres = null
          if (res != null) {
            res()
          }
        }
        break
      default:
        console.log('onStreamNetworkFinish unknown task')
    }
    // we could differentiate....
  }

  /**
   * @param {StreamRecvSignalEvent | StreamReadEvent | StreamWriteEvent | StreamResetEvent | StreamNetworkFinishEvent} args
   */
  static callback(args) {
    // console.log('Stream callback called', args)
    if (!args || !args.object || !args.object.jsobj)
      throw new Error('Stream callback without jsobj')
    const visitor = args.object.jsobj
    if (args.purpose) {
      switch (args.purpose) {
        case 'StreamRecvSignal':
          visitor.onStreamRecvSignal(args)
          break
        case 'StreamRead':
          if (
            visitor &&
            Object.prototype.hasOwnProperty.call(args, 'buffergrow')
          ) {
            visitor.onStreamRead(args)
          } else {
            console.log('Stream callback called', visitor, args)
            throw new Error('Malformed StreamRead')
          }
          break
        case 'StreamWrite':
          visitor.onStreamWrite(args)
          break
        case 'StreamReset':
          visitor.onStreamReset(args)
          break
        case 'StreamNetworkFinish':
          visitor.onStreamNetworkFinish(args)

          break
        default: {
          throw new Error('unknown purpose Streamcb')
        }
      }
    } else throw new Error('no purpose Streamcb')
  }
}
