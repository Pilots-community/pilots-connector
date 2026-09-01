/**
 * The Nest module, built from an already-assembled `Runtime`.
 *
 * Every service is provided as a value rather than through an async factory, so
 * the object graph is the one `runtime.ts` describes and Nest is left to do the
 * job it is actually good at here: routing, guards, and mapping the three
 * surfaces onto three auth layers.
 */
import { Module, type DynamicModule } from '@nestjs/common'

import { AdminController, AdminSessionController } from './api/admin.controller.js'
import { LocalController } from './api/local.controller.js'
import { PeerController } from './api/peer.controller.js'
import { WellKnownController } from './api/well-known.controller.js'
import { ADMIN_SESSIONS } from './auth/admin-session.service.js'
import { API_KEYS } from './auth/api-key.tokens.js'
import { AdminGuard, ApiKeyGuard, PeerGuard } from './auth/guards.js'
import { CONFIG } from './config/config.js'
import { DEFINITION_REGISTRY } from './definitions/definition-registry.js'
import { IDENTITY } from './identity/identity.service.js'
import { INSTANCE_SERVICE } from './instances/instance.tokens.js'
import { LOG_SERVICE } from './logging/log.service.js'
import { STORE } from './store/store.js'
import type { Runtime } from './runtime.js'

@Module({})
export class AppModule {
  static forRuntime(runtime: Runtime): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        WellKnownController,
        LocalController,
        AdminSessionController,
        AdminController,
        PeerController,
      ],
      providers: [
        { provide: CONFIG, useValue: runtime.config },
        { provide: STORE, useValue: runtime.store },
        { provide: IDENTITY, useValue: runtime.identity },
        { provide: DEFINITION_REGISTRY, useValue: runtime.registry },
        { provide: LOG_SERVICE, useValue: runtime.log },
        { provide: API_KEYS, useValue: runtime.apiKeys },
        { provide: ADMIN_SESSIONS, useValue: runtime.adminSessions },
        { provide: INSTANCE_SERVICE, useValue: runtime.instances },
        ApiKeyGuard,
        AdminGuard,
        PeerGuard,
      ],
    }
  }
}
