import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// Aplica o tema salvo antes do primeiro desenho, para a tela não piscar escura quando o tema é claro.
try {
  const saved = window.localStorage.getItem('telalink:theme')
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const light = saved === 'light' || (saved === 'system' && !systemDark)
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
} catch { /* sem armazenamento: segue o tema escuro padrão */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
