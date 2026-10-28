// adb through the CLI for the driver's own calls, and through the adb server's socket protocol for the
// connections uiautomator2 made with adbutils (device shell and device TCP ports).

import {execFile, spawn} from 'node:child_process'
import net from 'node:net'
import {tracked} from './util.ts'

export class CommandError extends Error {
  override name = 'CommandError'
}

/** Run adb and return stdout. Rejects on a non-zero exit or after `timeout` seconds, like subprocess.run(check=True). */
export function adb(args: string[], timeout = 30): Promise<string> {
  return tracked(`adb ${args.join(' ')}`, () => run('adb', args, timeout))
}

/** Run adb and return stdout whatever its exit code. Still rejects on a timeout, like subprocess.run without check. */
export function adbOutput(args: string[], timeout = 60): Promise<string> {
  return tracked(`adb ${args.join(' ')}`, () => run('adb', args, timeout, false))
}

/**
 * Run adb with its output on our stdout, like subprocess.run without check or capture. A non-zero exit is
 * ignored, a timeout still throws.
 */
export function adbPassthrough(args: string[], timeout = 60): Promise<void> {
  return tracked(`adb ${args.join(' ')}`, () => new Promise((resolve, reject) => {
    const child = spawn('adb', args, {stdio: ['ignore', 'inherit', 'inherit']})
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new CommandError(`adb ${args.join(' ')} timed out after ${timeout}s`))
    }, timeout * 1000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  }))
}

export function run(file: string, args: string[], timeout: number, check = true): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error && (check || error.killed || typeof error.code !== 'number')) {
        const why = error.killed ? `timed out after ${timeout}s` : `exited with ${error.code}`
        reject(new CommandError(`${file} ${args.join(' ')} ${why}: ${stderr.trim()}`, {cause: error}))
      } else resolve(stdout)
    })
  })
}

export class AdbError extends Error {
  override name = 'AdbError'
}

/** The peer reset or dropped the connection, like Python's ConnectionError. */
export class ConnectionLost extends Error {
  override name = 'ConnectionError'
}

export class SocketTimeout extends Error {
  override name = 'TimeoutError'
}

/** A socket to the adb server with buffered reads. */
export class AdbConnection {
  readonly socket: net.Socket
  #buffer = Buffer.alloc(0)
  #closed = false
  #error: Error | undefined
  #wake: (() => void) | undefined
  #onData: ((chunk: Buffer) => void) | undefined

  private constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      if (this.#onData) this.#onData(chunk)
      else this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#notify()
    })
    socket.on('end', () => {
      this.#closed = true
      this.#notify()
    })
    socket.on('close', () => {
      this.#closed = true
      this.#notify()
    })
    socket.on('error', (error) => {
      this.#error = new ConnectionLost(error.message, {cause: error})
      this.#closed = true
      this.#notify()
    })
    socket.on('timeout', () => {
      this.#error = new SocketTimeout('socket timeout')
      socket.destroy()
    })
  }

  static open(timeout: number): Promise<AdbConnection> {
    const host = process.env.ANDROID_ADB_SERVER_HOST ?? '127.0.0.1'
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT ?? 5037)
    return new Promise((resolve, reject) => {
      const socket = net.connect({host, port})
      socket.setTimeout(timeout * 1000)
      socket.once('connect', () => resolve(new AdbConnection(socket)))
      socket.once('error', (error) => reject(new AdbError(`cannot reach the adb server: ${error.message}`, {cause: error})))
      socket.once('timeout', () => {
        socket.destroy()
        reject(new AdbError('timeout connecting to the adb server'))
      })
    })
  }

  /** Connect to the device's adbd and open `service` on it, e.g. "shell:ls" or "tcp:9008". */
  static async service(service: string, timeout: number): Promise<AdbConnection> {
    const c = await AdbConnection.open(timeout)
    try {
      const serial = process.env.ANDROID_SERIAL
      await c.command(serial ? `host:transport:${serial}` : 'host:transport-any')
      await c.command(service)
      return c
    } catch (error) {
      c.close()
      throw error
    }
  }

  #notify(): void {
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  #waitForData(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = resolve
    })
  }

  async command(cmd: string): Promise<void> {
    const body = Buffer.from(cmd, 'utf8')
    this.socket.write(Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, '0')), body]))
    const status = (await this.readExact(4)).toString()
    if (status === 'OKAY') return
    if (status === 'FAIL') {
      const length = parseInt((await this.readExact(4)).toString(), 16)
      throw new AdbError((await this.readExact(length)).toString())
    }
    throw new AdbError(`unknown data: ${JSON.stringify(status)}`)
  }

  async readExact(n: number): Promise<Buffer> {
    while (this.#buffer.length < n) {
      if (this.#closed) {
        if (this.#error) throw this.#error
        throw new AdbError('connection closed')
      }
      await this.#waitForData()
    }
    const out = this.#buffer.subarray(0, n)
    this.#buffer = this.#buffer.subarray(n)
    return out
  }

  /** Read what has arrived so far, waiting for more until `done` says the bytes are complete or the peer closes. */
  async readUntil(done: (data: Buffer) => boolean): Promise<Buffer> {
    while (!done(this.#buffer)) {
      if (this.#closed) {
        if (this.#error) throw this.#error
        break
      }
      await this.#waitForData()
    }
    return this.#buffer
  }

  /** Hand every later chunk to `onData` instead of buffering it. */
  stream(onData: (chunk: Buffer) => void): void {
    if (this.#buffer.length) onData(this.#buffer)
    this.#buffer = Buffer.alloc(0)
    this.#onData = onData
  }

  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    this.socket.destroy()
  }
}

/** Run a shell command on the device over the socket protocol and return its output, like adbutils shell(). */
export async function deviceShell(cmd: string, timeout = 600): Promise<string> {
  return tracked(`shell ${cmd}`, async () => {
    const c = await AdbConnection.service(`shell:${cmd}`, timeout)
    try {
      return (await c.readUntil(() => false)).toString('utf8').trimEnd()
    } finally {
      c.close()
    }
  })
}

/** Quote arguments for the device shell, like Python's shlex.quote. */
export function shellQuote(args: string[]): string {
  return args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'"'"'`)}'`)).join(' ')
}
