# Dashboard (React + Vite)

A water-quality monitoring dashboard built with React, Vite, Tailwind CSS, shadcn/ui and Recharts. It polls the AWS API every 5 seconds.

```powershell
npm install
copy .env.example .env.local   # set VITE_API_BASE_URL (terraform output api_url)
npm run dev                    # http://localhost:5173
npm run build                  # production build in dist/
```

If `VITE_API_BASE_URL` is empty, or `VITE_DATA_MODE=mock`, the app runs in **mock mode**: it generates sample data in the browser and shows a yellow banner saying so.

| Folder | What's in it |
|---|---|
| `src/pages/` | The 6 pages (Dashboard, Stations + detail, Sensor Monitoring, Alerts, Analytics, Simulation) |
| `src/components/` | The layout, status badges, charts, sensor value tiles, and loading/empty/error states |
| `src/components/ui/` | shadcn/ui components |
| `src/lib/` | The API client, polling hook, history loader, formatting and CSV export, and mock data |
