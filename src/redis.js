import net from "node:net";

function encodeRespArray(parts) {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) {
    const text = String(part);
    out += `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  }
  return out;
}

function parseResp(buffer) {
  if (buffer.length === 0) return { complete: false };
  const prefix = String.fromCharCode(buffer[0]);
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) return { complete: false };
  const line = buffer.subarray(1, lineEnd).toString("utf8");

  if (prefix === "+") {
    return { complete: true, value: line };
  }
  if (prefix === "-") {
    throw new Error(`Redis error: ${line}`);
  }
  if (prefix === ":") {
    return { complete: true, value: Number(line) };
  }
  if (prefix !== "$") {
    throw new Error(`Unsupported Redis RESP prefix: ${prefix}`);
  }

  const length = Number(line);
  if (length === -1) return { complete: true, value: null };
  const start = lineEnd + 2;
  const end = start + length;
  if (buffer.length < end + 2) return { complete: false };
  return { complete: true, value: buffer.subarray(start, end).toString("utf8") };
}

export function redisCommand(redisUrl, parts, timeoutMs = 5000) {
  const url = new URL(redisUrl);
  const host = url.hostname || "localhost";
  const port = Number(url.port || 6379);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Redis command timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("connect", () => {
      socket.write(encodeRespArray(parts));
    });

    socket.on("data", (chunk) => {
      chunks.push(chunk);
      try {
        const parsed = parseResp(Buffer.concat(chunks));
        if (!parsed.complete) return;
        clearTimeout(timer);
        socket.destroy();
        resolve(parsed.value);
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function redisGet(redisUrl, key, timeoutMs = 5000) {
  return redisCommand(redisUrl, ["GET", key], timeoutMs);
}

export function redisSet(redisUrl, key, value, timeoutMs = 5000) {
  return redisCommand(redisUrl, ["SET", key, value], timeoutMs);
}

export function redisPublish(redisUrl, channel, value, timeoutMs = 5000) {
  return redisCommand(redisUrl, ["PUBLISH", channel, value], timeoutMs);
}
