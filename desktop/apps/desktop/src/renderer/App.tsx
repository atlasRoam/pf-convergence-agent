import { AppView } from "./app-view";
import { useAppController } from "./use-app-controller";

export function App() {
  const controller = useAppController();
  return <AppView controller={controller} />;
}
