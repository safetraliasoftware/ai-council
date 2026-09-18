// Renderer component tests use useTranslation() without an <I18nextProvider>
// wrapper, relying on the global i18next singleton react-i18next registers
// via initReactI18next. It must be initialized (and, since init() is async,
// actually finished) before any component renders - awaited here once for
// every test in this workspace via vitest's setupFiles, so tests keep
// asserting the same German text as before this refactor without needing to
// wire i18n themselves.
import { i18nReady } from './index'

await i18nReady
