export type Region = 'global' | 'cn';

export interface Hosts {
  /** Second-level domain, `garmin.com` or `garmin.cn`. */
  domain: string;
  connectapi: string;
  sso: string;
  diauth: string;
  /** Service URL used by the iOS mobile SSO flow; must match during ticket exchange. */
  mobileServiceUrl: string;
  /** Garmin Connect web app; the service the browser sign-in redirects to with ?ticket=. */
  portalServiceUrl: string;
  /** Sign-in page shown in the browser login. */
  portalSignInUrl: string;
}

export function hostsForRegion(region: Region): Hosts {
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com';
  return {
    domain,
    connectapi: `https://connectapi.${domain}`,
    sso: `https://sso.${domain}`,
    diauth: `https://diauth.${domain}`,
    mobileServiceUrl: `https://mobile.integration.${domain}/gcm/ios`,
    portalServiceUrl: `https://connect.${domain}/app`,
    portalSignInUrl: `https://sso.${domain}/portal/sso/en-US/sign-in`,
  };
}
