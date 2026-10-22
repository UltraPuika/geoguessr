import { Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment.local';

export class MapsApiError extends Error {
  constructor(
    message: string,
    readonly code: 'missing-key' | 'load-failed' | 'auth-failed',
  ) {
    super(message);
    this.name = 'MapsApiError';
  }
}

const PLACEHOLDER = 'YOUR_GOOGLE_MAPS_API_KEY';

type GmWindow = Window & {
  google?: typeof google;
  gm_authFailure?: () => void;
  __gmInit?: () => void;
};

/**
 * Loads the Maps JavaScript API lazily, only when Street View is actually needed.
 * Loading the script alone does not create a panorama and is not a Dynamic Street View event.
 */
@Injectable({ providedIn: 'root' })
export class GoogleMapsLoaderService {
  private loading: Promise<google.maps.StreetViewLibrary> | null = null;
  readonly authFailed = signal(false);

  get apiKey(): string {
    const key = environment.googleMapsApiKey?.trim() ?? '';
    return key === PLACEHOLDER ? '' : key;
  }

  get hasKey(): boolean {
    return this.apiKey.length > 0;
  }

  load(): Promise<google.maps.StreetViewLibrary> {
    if (this.authFailed()) {
      return Promise.reject(new MapsApiError('Google rejected the API key (see console for details).', 'auth-failed'));
    }
    if (!this.hasKey) {
      return Promise.reject(
        new MapsApiError('No Google Maps API key is configured. See README → "Configure the API key".', 'missing-key'),
      );
    }
    this.loading ??= this.inject().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async inject(): Promise<google.maps.StreetViewLibrary> {
    const w = window as GmWindow;
    w.gm_authFailure = () => this.authFailed.set(true);
    if (!w.google?.maps?.importLibrary) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        const params = new URLSearchParams({
          key: this.apiKey,
          v: 'weekly',
          loading: 'async',
          callback: '__gmInit',
        });
        script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
        script.async = true;
        w.__gmInit = () => resolve();
        script.onerror = () => {
          script.remove();
          reject(new MapsApiError('Could not load the Google Maps JavaScript API. Check your connection.', 'load-failed'));
        };
        document.head.appendChild(script);
      });
    }
    return (await google.maps.importLibrary('streetView')) as google.maps.StreetViewLibrary;
  }
}
