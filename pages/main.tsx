/**
 * The Bassapps sign-in pages: /sign-in, and /account once signed in (/ goes to whichever fits).
 * Their own small app at the sign-in service's address (vite.config.ts).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './door.css'
import { SignIn } from './SignIn'
import { Account } from './Account'

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {window.location.pathname.startsWith('/account') ? <Account /> : <SignIn />}
    </StrictMode>,
)
