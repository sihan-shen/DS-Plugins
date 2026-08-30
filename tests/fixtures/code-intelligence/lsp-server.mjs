const decoder = new TextDecoder('utf-8', { fatal: true })
let buffered = Buffer.alloc(0)

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, 'ascii'), body])
}

function respond(message) {
  if (message.method === 'initialize') {
    process.stdout.write(frame({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true } } }))
  } else if (message.method === 'textDocument/documentSymbol') {
    process.stdout.write(frame({ jsonrpc: '2.0', id: message.id, result: [{
      name: 'fixtureSymbol', kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } },
    }] }))
  } else if (message.method === 'shutdown') {
    process.stdout.write(frame({ jsonrpc: '2.0', id: message.id, result: null }))
  } else if (message.method === 'exit') {
    process.exit(0)
  }
}

process.stdin.on('data', chunk => {
  buffered = Buffer.concat([buffered, chunk])
  while (true) {
    const boundary = buffered.indexOf('\r\n\r\n')
    if (boundary < 0) return
    const header = decoder.decode(buffered.subarray(0, boundary))
    const match = /^Content-Length:\s*(\d+)$/im.exec(header)
    if (!match) process.exit(2)
    const length = Number(match[1])
    const end = boundary + 4 + length
    if (buffered.byteLength < end) return
    const message = JSON.parse(decoder.decode(buffered.subarray(boundary + 4, end)))
    buffered = buffered.subarray(end)
    respond(message)
  }
})
