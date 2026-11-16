import { lazy, Suspense } from "react";
import { Link, Route, Routes } from "react-router";
import { DataProvider } from "@/components/DataProvider";
import { Layout } from "@/components/Layout";
import { EmptyState, LoadingBlock } from "@/components/States";

// Each page is loaded when first opened (smaller initial download).
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Stations = lazy(() => import("@/pages/Stations"));
const StationDetail = lazy(() => import("@/pages/StationDetail"));
const Monitoring = lazy(() => import("@/pages/Monitoring"));
const Alerts = lazy(() => import("@/pages/Alerts"));
const Analytics = lazy(() => import("@/pages/Analytics"));
const Simulation = lazy(() => import("@/pages/Simulation"));

function NotFound() {
  return <EmptyState title="Page not found"><Link to="/" className="underline">Go to the dashboard</Link></EmptyState>;
}

const page = (Component) => (
  <Suspense fallback={<LoadingBlock rows={3} />}>
    <Component />
  </Suspense>
);

export default function App() {
  return (
    <DataProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={page(Dashboard)} />
          <Route path="stations" element={page(Stations)} />
          <Route path="stations/:deviceId" element={page(StationDetail)} />
          <Route path="monitoring" element={page(Monitoring)} />
          <Route path="alerts" element={page(Alerts)} />
          <Route path="analytics" element={page(Analytics)} />
          <Route path="simulation" element={page(Simulation)} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </DataProvider>
  );
}
