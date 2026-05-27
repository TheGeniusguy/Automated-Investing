import { ErrorBoundary } from "./components/ErrorBoundary";
import { TerminalShell } from "./components/TerminalShell";

export default function App() {
  return (
    <ErrorBoundary panel={false}>
      <TerminalShell />
    </ErrorBoundary>
  );
}
