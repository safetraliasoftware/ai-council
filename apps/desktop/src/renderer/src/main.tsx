import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import i18n from './i18n'

// Apply the persisted language before the first render so there is no
// visible flash of German for a non-German user on every app start.
void window.api.settings.getLanguage().then((language) => i18n.changeLanguage(language)).finally(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
