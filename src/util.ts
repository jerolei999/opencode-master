export function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function newID(prefix: string, bytes = 16): string {
  return `${prefix}_${randomHex(bytes)}`
}
