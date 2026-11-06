/**
 * Shell service augmentations.
 *
 * `ambient.d.ts` declares the browser modules the DSH shell supplies. This
 * module file augments the cordis `Context` with the client services those
 * modules register, so the plugin body typechecks against the real runtime
 * shape instead of `any`.
 */
import type { SlotsService, LocaleService, ConfigFormsService } from '@deepseek-ai/dsh-client-ui-slots';
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client';

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotsService;
    locale: LocaleService;
    configForms: ConfigFormsService;
    remote: ClientRemote;
  }
}
export {};
