
import {EventEmitter} from './simple-event-emitter/simple-event-emitter.js'

/*
Packet structure:
{
  id: unique ID identifying this call or which call has a result or error reply
  cmd: the name of the procedure/function to call
  event: the name of an event to emit
  args: the args to pass to cmd or event
  result: the result of a cmd call (if it didn't throw)
  error: if a cmd call threw an error
  protocolError: if a packet caused an error
}
*/

/** Implement RPC over any IO connection by correctly using: `isClosed`, `onSend`, `handlePacket` and `handleClose`. */
export class RPCBridge extends EventEmitter {
  /** The serializer used. */
  serializer
  /** The deserializer used. */
  deserializer
  /** Bind commands to functions here (it's ok to replace this `Map` with a new one at any time). */
  functionMap = new Map()
  /** Should calls still waiting for results throw an error if the connection is closed? */
  throwAwaitingResultsOnClose = true
  /** Setup a function handling the data to send. */
  onSend
  
  #callId = 1; #isOpen = false; #awaitingResult = new Map()

  get isOpen() {return this.#isOpen}
  /** Set to true when a connection is ready and false when it isn't. If false then no more data will be sent and calls to `call` or `emit` will throw. */
  set isOpen(open) {
    if (this.#isOpen && !open) {
      super.emit('close')
      if (this.throwAwaitingResultsOnClose) {
        this.rejectResults(`The connection closed before any incoming result.`)
      }
    } else if (!this.#isOpen && open) {
      super.emit('open')
    }
    this.#isOpen = open
  }
  
  /** By default it's using `JSON.stringify` as the `serializer`. A serializer must either return a string or binary data. It can also be async. So if you want a more capable serializer (e.g. one using an efficient binary protocol) you're free to replace it. */
  constructor({serializer = JSON.stringify, deserializer = JSON.parse} = {}) {
    super()
    Object.seal(this)
    this.serializer = serializer
    this.deserializer = deserializer
  }
  
  /** Manually reject any outgoing calls which hasn't received a result yet. */
  rejectResults(message) {
    for (const [id, {resolve, reject}] of this.#awaitingResult) {
      reject(message)
    }
    this.#awaitingResult.clear()
  }
  
  async #send(packet) {
    if (!this.#isOpen) return
    const serialized = await this.serializer(packet)
    return this.onSend(serialized)
    // this.#connection?.send(serialized)
  }
  
  /** Bind a function to a callable command. */
  bind(cmd, func) {
    if (typeof func != 'function') {
      throw Error(`Expected a function.`)
    }
    this.functionMap.set(cmd, func)
  }

  /** Unbind a function from command (if any) */
  unbind(cmd) {
    return this.functionMap.delete(cmd)
  }

  /** Bind all instance methods as functions which can be called. */
  bindInstance(instance) {
    const proto = Object.getPrototypeOf(instance)
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key == 'constructor') continue
      if (typeof instance[key] == 'function') {
        this.functionMap.set(key, instance[key].bind(instance))
      }
    }
  }

  /** @deprecated see bind */
  registerFunction(cmd, func) {
    return this.bind(cmd, func)
  }

  /** @deprecated see bindInstance */
  registerInstanceFunctions(instance) {
    return this.bindInstance(instance)
  }
  
  /** Calls the remote function linked to `cmd`. */
  call(cmd, ...args) {
    if (!this.#isOpen) throw Error('RPC connection not open.')
    const id = this.#callId ++
    const packet = {id, cmd, args}
    this.#send(packet)
    return new Promise((resolve, reject) => {
      this.#awaitingResult.set(id, {resolve, reject})
    })
  }

  /** Emits an event on the other side. */
  emit(event, ...args) {
    if (!this.#isOpen) throw Error('RPC connection not open.')
    const packet = {event, args}
    this.#send(packet)
  }

  /** Calls the local function linked to `cmd`. */
  localCall(cmd, ...args) {
    const func = this.functionMap.get(cmd)
    if (!func) throw Error(`No function bound to: ${cmd}`)
    return func(...args)
  }

  /** Emits an event on the local side. */
  localEmit(event, ...args) {
    super.emit(event, ...args)
  }

  /** Get a proxy object which will return a function to execute `call` for you on any method you access. But not on `then()` since it has a special meaning. */
  proxy() {
    const self = this
    return new Proxy({}, {
      get: function(target, method) {
        switch (method) {
          case 'then': return // (await can try to read this)
        }
        return function(...args) {
          return self.call(method, ...args)
        }
      }
    })
  }
  
  /** Manually trigger the "on connection data" handler. */
  handlePacket = packet => {
    try {
      try {
        packet = this.deserializer(packet)
      } catch (error) {
        throw `Receiver failed to deserialize: `+error
      }
      if (typeof packet != 'object') {
        throw `Packet not deserialized to an object.`
      }
      const {id, cmd, event, args, protocolError} = packet
      if (cmd) {
        return this.#handleIncomingCall(packet)
      }
      if (id) { // other than 'cmd' only 'result' and 'error' includes an ID
        return this.#handleIncomingResult(packet)
      }
      if (event) {
        return super.emit(event, ...args)
      }
      if (protocolError) {
        return super.emit('error', protocolError)
      }
      throw `Unknown packet type.`
    } catch (error) {
      this.#send({protocolError: {
        message: `Invalid packet caused an error: `+error,
        returnToSender: packet
      }})
    }
  }
  
  async #handleIncomingCall(incomingPacket) {
    const {id, cmd, args} = incomingPacket
    let packet
    const func = this.functionMap.get(cmd)
    if (func) {
      try {
        const result = await func(...args)
        packet = {id, result}
      } catch (error) {
        packet = {id, error}
      }
    } else {
      packet = {id, error: `No function bound to: ${cmd}`}
    }
    this.#send(packet)
  }
  
  #handleIncomingResult(packet) {
    const {id, result, error} = packet
    const awaitingResult = this.#awaitingResult.get(id)
    if (awaitingResult) {
      this.#awaitingResult.delete(id)
      if ('result' in packet) {
        awaitingResult.resolve(result)
      } else {
        awaitingResult.reject(error)
      }
    } else {
      throw `Not expecting a result.`
    }
  }
  
}
