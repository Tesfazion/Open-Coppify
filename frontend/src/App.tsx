import { Navigate, Route, Routes } from 'react-router-dom'

import AppShell from './components/AppShell'
import About from './pages/About'
import Ingest from './pages/Ingest'
import JobProgress from './pages/JobProgress'
import Library from './pages/Library'
import Review from './pages/Review'
import SettingsPage from './pages/Settings'

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Ingest />} />
        <Route path="/library" element={<Library />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/about" element={<About />} />
        <Route path="/jobs/:jobId" element={<JobProgress />} />
        <Route path="/jobs/:jobId/clips" element={<Review />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}
