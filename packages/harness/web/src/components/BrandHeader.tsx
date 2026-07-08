import type { JSX } from "react";

import sapiomMark from "../assets/sapiom-mark.svg";

interface BrandHeaderProps {
  authenticated: boolean;
  organizationName: string | null;
}

export function BrandHeader({ authenticated, organizationName }: BrandHeaderProps): JSX.Element {
  return (
    <header className="brand-header">
      <div className="brand-lockup">
        <img src={sapiomMark} alt="" className="brand-mark" />
        <span className="brand-name">Sapiom</span>
        <span className="brand-divider" />
        <span className="brand-product">Harness</span>
      </div>

      <div className="brand-identity" data-testid="brand-identity">
        <span className="identity-dot" data-authenticated={authenticated} />
        {authenticated ? (organizationName ?? "Signed in") : "Not signed in"}
      </div>
    </header>
  );
}
