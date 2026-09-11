import { createHash } from "crypto"

export namespace Hash {
  export function fast(input: string | Buffer): string {
    return createHash("sha1").update(typeof input === "string" ? input : Uint8Array.from(input)).digest("hex")
  }

  export function sha256(input: string | Buffer): string {
    return createHash("sha256").update(typeof input === "string" ? input : Uint8Array.from(input)).digest("hex")
  }
}
