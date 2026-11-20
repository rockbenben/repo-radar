const {createServer} = require('node:http')
const {createReadStream, statSync} = require('node:fs')
const {join} = require('node:path')
const [directory, manifest, image] = process.argv.slice(2)
createServer((req, res) => {
  const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1)
  if (name !== manifest && name !== image) {
    res.writeHead(404).end()
    return
  }
  console.log(req.method, name, req.headers.range ?? 'full')
  const file = join(directory, name)
  const size = statSync(file).size
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start > end || end >= size) {
    res.writeHead(416, {'Content-Range': 'bytes */' + size}).end()
    return
  }
  res.setHeader('Content-Length', end - start + 1)
  res.setHeader('Accept-Ranges', 'bytes')
  if (range) res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size)
  res.writeHead(range ? 206 : 200)
  if (req.method === 'HEAD') res.end()
  else createReadStream(file, { start, end }).pipe(res)
}).listen(19427, '127.0.0.1')
