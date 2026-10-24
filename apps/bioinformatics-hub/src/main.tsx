import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { I18nProvider } from './i18n'
import WorkflowWorkbench from './WorkflowWorkbench'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <WorkflowWorkbench />
    </I18nProvider>
  </StrictMode>,
)
