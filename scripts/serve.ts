// Serve a directory over HTTP for the test pages, in place of `python3 -m http.server`.
// Logs one line per request in http.server's format.
//
// Usage: node scripts/serve.ts <dir> <port>

import {createReadStream, statSync} from 'node:fs'
import http from 'node:http'
import {extname, join, normalize, sep} from 'node:path'

const root = normalize(process.argv[2]!)
const port = Number(process.argv[3])

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function stamp(): string {
  const d = new Date()
  const month = d.toLocaleString('en-US', {month: 'short'})
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${month}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  let path = normalize(join(root, pathname))
  let status = 200
  try {
    if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('outside root')
    if (statSync(path).isDirectory()) path = join(path, 'index.html')
    const size = statSync(path).size
    res.writeHead(200, {'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-length': size})
    if (req.method === 'HEAD') res.end()
    else createReadStream(path).pipe(res)
  } catch {
    status = 404
    res.writeHead(404, {'content-type': 'text/plain'})
    res.end('not found')
  }
  console.log(`${req.socket.remoteAddress?.replace(/^::ffff:/, '')} - - [${stamp()}] "${req.method} ${req.url} HTTP/${req.httpVersion}" ${status} -`)
})

server.listen(port, () => console.log(`Serving HTTP on 0.0.0.0 port ${port} (http://0.0.0.0:${port}/) ...`))
