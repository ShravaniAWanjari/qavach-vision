import { createHashRouter, Navigate, Outlet, RouterProvider, useParams } from 'react-router';
import { Shell } from './components/Shell';
import { Overview } from './pages/Overview';
import { VideoWall, WallScreen } from './pages/wall/VideoWall';
import { Alerts } from './pages/alerts/Alerts';
import { Cameras } from './pages/cameras/Cameras';
import { Rules } from './pages/rules/Rules';
import { Phone } from './pages/phone/Phone';
import { AlertsSection, CameraSection, Configuration, NewRuleSection, RuleSection, WallSection } from './pages/configuration/Configuration';
import { useBackendBridge } from './state/bridge';
import { useEngine } from './state/engine';

// The old addresses still work and land in Configuration.
const To = ({ base }: { base: string }) => {
  const p = useParams();
  return <Navigate to={`${base}${p.cameraId ?? p.ruleId ?? ''}`} replace />;
};

// Hash routes so the built prototype also works opened straight from disk.
function Root() {
  useEngine();
  useBackendBridge();
  return <Outlet />;
}

const router = createHashRouter([
  {
    element: <Root />,
    children: [
      {
        element: <Shell />,
        children: [
          { path: '/', element: <Overview /> },
          { path: '/wall', element: <VideoWall /> },
          { path: '/wall/:wallId', element: <VideoWall /> },
          { path: '/alerts', element: <Alerts /> },
          { path: '/alerts/:alertId', element: <Alerts /> },
          { path: '/cameras', element: <Cameras /> },
          { path: '/cameras/new', element: <Navigate to="/configuration/cameras" replace /> },
          { path: '/cameras/:cameraId', element: <To base="/configuration/cameras/" /> },
          { path: '/rules', element: <Rules /> },
          { path: '/rules/new', element: <Navigate to="/configuration/rules" replace /> },
          { path: '/rules/:ruleId', element: <To base="/configuration/rules/" /> },
          { path: '/notifications', element: <Navigate to="/configuration/alerts" replace /> },
          {
            path: '/configuration',
            element: <Configuration />,
            children: [
              { index: true, element: <Navigate to="alerts" replace /> },
              { path: 'alerts', element: <AlertsSection /> },
              { path: 'rules', element: <NewRuleSection /> },
              { path: 'rules/:ruleId', element: <RuleSection /> },
              { path: 'cameras', element: <CameraSection /> },
              { path: 'cameras/:cameraId', element: <CameraSection /> },
              { path: 'walls', element: <WallSection /> },
            ],
          },
        ],
      },
      { path: '/screen/:wallId', element: <WallScreen /> },
      { path: '/m', element: <Phone /> },
      { path: '/m/:alertId', element: <Phone /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
