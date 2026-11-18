/**
 * The Bassapps sign-in pages: /sign-in, and /account once signed in (/ goes to whichever fits).
 * Their own small app at the sign-in service's address (vite.config.ts).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import './door.css'
import { SignIn } from './SignIn'
import { Account } from './Account'
import { watchInput } from './inputModality'

// The focus ring shows only after a key press when focus moves on its own (rule K3)
watchInput()

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {window.location.pathname.startsWith('/account') ? <Account /> : <SignIn />}
    </StrictMode>,
)
