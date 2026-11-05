import { createBrowserRouter } from 'react-router'
import { LandingPage } from './pages/LandingPage'
import { EditProfilePage } from './pages/EditProfilePage'
import { PublicCardPage } from './pages/PublicCardPage'
import { ConnectionsPage } from './pages/ConnectionsPage'
import { AboutPage } from './pages/AboutPage'
import { AdminPage } from './pages/AdminPage'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <LandingPage />,
  },
  {
    path: '/edit',
    element: <EditProfilePage />,
  },
  {
    path: '/connections',
    element: <ConnectionsPage />,
  },
  {
    path: '/admin',
    element: <AdminPage />,
  },
  {
    path: '/p/:id',
    element: <PublicCardPage />,
  },
  {
    path: '/about',
    element: <AboutPage />,
  },
  // Custom vanity URLs (`/@{slug}`). React Router's path syntax can't
  // combine a literal `@` with a `:param` in the same segment, so this is
  // registered as a plain catch-all single-segment route instead — static
  // routes above (/, /edit, /connections, /admin, /p/:id, /about) always
  // take priority over it regardless of declaration order, and PublicCardPage
  // itself rejects anything that isn't `@`-prefixed.
  {
    path: '/:slug',
    element: <PublicCardPage />,
  },
])
