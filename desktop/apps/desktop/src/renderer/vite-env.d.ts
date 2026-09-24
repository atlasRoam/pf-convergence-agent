import type { PfsaaBridge } from "@pfsaa/contracts";

declare module "./styles.css" {
  const styles: string;
  export default styles;
}

declare global {
  interface Window {
    pfsaa: PfsaaBridge;
  }
}

export {};
