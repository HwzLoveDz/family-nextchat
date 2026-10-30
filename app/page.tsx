import { FamilyApp } from "./family/client";

// This fork is a private family application. Missing deployment configuration
// must never bring back the anonymous legacy application or its local stores.
export default function App() {
  return <FamilyApp />;
}
