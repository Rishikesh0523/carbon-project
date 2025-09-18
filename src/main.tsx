import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Polyfill Buffer for browser compatibility
import { Buffer } from 'buffer'
globalThis.Buffer = Buffer

// Polyfill BN for BigNumber operations
import BN from 'bn.js'
;(globalThis as any).BN = BN

// Polyfill process for Solana libraries
if (!globalThis.process) {
  globalThis.process = {
    env: {},
    version: '',
    versions: {},
  } as any
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
