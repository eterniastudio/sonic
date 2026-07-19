import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/barlow-condensed/latin-700.css";
import { SonicApp } from "./app/SonicApp";
import { SonicProvider } from "./app/SonicProvider";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/sonic.css";

export default function App() {
  return (
    <SonicProvider>
      <SonicApp />
    </SonicProvider>
  );
}
