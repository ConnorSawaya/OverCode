import { Capacitor, registerPlugin } from "@capacitor/core"

type SecureStoragePlugin = {
  get(input: { key: string }): Promise<{ value?: string }>
  set(input: { key: string; value: string }): Promise<void>
  remove(input: { key: string }): Promise<void>
}

const nativeStorage = registerPlugin<SecureStoragePlugin>("OvercodeSecureStorage")

export async function secureGet(key: string) {
  if (!Capacitor.isNativePlatform()) return localStorage.getItem(key) ?? undefined
  return (await nativeStorage.get({ key })).value
}

export async function secureSet(key: string, value: string) {
  if (!Capacitor.isNativePlatform()) {
    localStorage.setItem(key, value)
    return
  }
  await nativeStorage.set({ key, value })
}

export async function secureRemove(key: string) {
  if (!Capacitor.isNativePlatform()) {
    localStorage.removeItem(key)
    return
  }
  await nativeStorage.remove({ key })
}
