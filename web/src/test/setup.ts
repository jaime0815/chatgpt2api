import "@testing-library/jest-dom/vitest"
import "fake-indexeddb/auto"

import { cleanup } from "@testing-library/react"
import { IDBFactory } from "fake-indexeddb"
import { afterEach, vi } from "vitest"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
  globalThis.indexedDB = new IDBFactory()
})
