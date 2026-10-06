import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";
import { Layout } from "./components/Layout.tsx";
import { AuthProfiles } from "./pages/AuthProfiles.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Jobs } from "./pages/Jobs.tsx";
import { RecordingDetail } from "./pages/RecordingDetail.tsx";
import { Recordings } from "./pages/Recordings.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { Runs } from "./pages/Runs.tsx";
import { Schedules } from "./pages/Schedules.tsx";
import { Settings } from "./pages/Settings.tsx";
import { Empty } from "./ui.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2000, retry: false, refetchOnWindowFocus: true } },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/recordings" element={<Recordings />} />
            <Route path="/recordings/:id" element={<RecordingDetail />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/auth" element={<AuthProfiles />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Empty>There is nothing at this address.</Empty>} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
