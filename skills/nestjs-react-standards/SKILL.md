---
name: nestjs-react-standards
description: Coding standards, patterns, and conventions for TypeScript/NestJS/React/MUI/Mongoose projects. Apply when writing or reviewing code in this stack.
---

# NestJS + React Coding Standards

These are the rules and principles the team follows. Apply when writing or reviewing code.

---

## Universal Rules (All Packages)

### Naming
- **No comments** — code must be self-documenting through naming alone
- **No abbreviated names** — use full descriptive names. Only exceptions: `i`/`j`/`k`, `id`, `url`, `dto`, `api`, `db`, `x`/`y`/`z`
- **kebab-case** for all file names
- **PascalCase** for class and component exports
- **Enums over string unions** — enum values must be PascalCase matching their key names

### Types
- **Interfaces over types** — use `interface` for objects, `type` only for unions/intersections/primitives/mapped types
- **Avoid unnecessary `as` casts** — fix the type at its source instead of asserting
- **DTOs are classes** (not interfaces) — enables class-validator decorators and Swagger generation

### File Organization
- **~200 lines max** per file — split into focused modules when approaching this
- **Barrel exports** (`index.ts`) at every directory level
- **New line after closing braces** — enforced by ESLint padding rules
- **Complex features** get subdirectories: `components/`, `hooks/`, `tabs/`, `dto/`, `interfaces/`

---

## Security Standards

### Never Do
- Never hardcode secrets — all via environment variables through `ConfigService`
- Never return password hashes, API key hashes, or internal tokens in API responses
- Never pass user input directly to `$regex` — always wrap with `escapeRegex()` first
- Never expose debug error messages to users — separate debug from user-facing messages
- Never allow dev-only routes in production — gate with `@DevRoute()` decorator
- Never enumerate users — return generic errors for invalid credentials, silent fail for non-existent users

### Always Do
- Always hash passwords and API keys with bcrypt before storing
- Always generate tokens with `crypto.randomBytes()` — never Math.random()
- Always sanitize HTML input with DOMPurify via `@SafeHtmlTransform()`
- Always validate and transform ObjectIds with `@IsMongoIdTransform()` — never trust raw string IDs
- Always set `httpOnly: true` on cookies
- Always set `sameSite` appropriately: `'strict'` in prod, `'lax'` in dev
- Always track failed auth attempts with lockout thresholds
- Always use scope + IP whitelist validation for API keys

### Authentication Architecture
- Global guard stack applies to ALL routes by default — opt out with `@SkipJWT()`, not opt in
- Dual token extraction: cookie first, then Bearer header — supports both browser and API clients
- Resource permissions are hierarchical — child resources forward permission checks to parents
- WebSocket auth must check token from multiple sources: cookie, header, handshake auth, query param

---

## Backend Standards (NestJS)

### Module Organization
- One module per feature domain
- Controllers, services, DTOs each in their own files with NestJS suffix conventions
- Use `forwardRef()` for circular module dependencies — don't restructure to avoid it
- Export only the services other modules need — keep internals private
- All modules registered in a single barrel export that AppModule spreads

### Controller Rules
- Always use `@ApiTagWithAuthController()` — never bare `@Controller()` + `@ApiTags()` separately
- Class-level `DocumentInterceptor` for Mongoose document responses
- Method-level `DtoInterceptor` when a specific endpoint returns a different shape
- Default exports for controllers
- Parameter extraction via destructured DTOs: `@Param() { id }: ParamsWithId` — never raw `@Param('id')`
- Permission decorators go on the method, not the class

### Service Rules
- Default exports for services
- Every find-by-id method must have `@HandleDocumentNotFound(Schema)` — never manually check for null
- Wrap creates/upserts with `handleMongoDuplicateKey()` — never catch duplicate key errors manually
- Multi-document writes must use `handleTransaction()` — never raw sessions
- Implement `ResourceExistence` interface when the service's entity participates in permission checks
- Populate user references selecting only `firstName lastName image` — never full user documents

### DTO Rules
- Request DTOs use class-validator decorators for validation
- Response DTOs extend `BaseDtoWithId` to expose `_id` as `id`
- Sensitive fields marked with both `@Exclude()` AND `@ApiHideProperty()`
- ObjectId fields use `@ExposeId()` in responses
- ObjectId inputs use `@IsMongoIdTransform()` — validates AND transforms in one decorator
- Optional fields use `@IsOptional()` — never nullable without it
- File naming: `{operation}-{entity}.dto.ts` (e.g., `create-course.dto.ts`)

### Schema Rules
- All schemas extend `BaseDtoWithId`
- Always enable `@Schema({ timestamps: true })`
- Define indexes after schema creation, not in decorators
- Use soft delete plugin — never hard delete user-facing data
- Polymorphic nested types use discriminators — never type unions
- Enum fields use `enum` property in `@Prop()` — never plain strings

### Query Rules
- Optional filters use conditional spread: `...(field ? { field } : {})`
- Complex multi-collection queries use aggregation pipelines — not chained `.populate()`
- Name search uses `createNameSearchQuery()` utility — never hand-roll regex search
- Pagination uses `addPagination()` utility — never manual skip/limit
- Always use `collectionName()` helper in `$lookup` — never hardcode collection names

### Error Handling Rules
- Use custom exception classes: `DocumentNotFoundException`, `PermissionDeniedException`
- Error messages must not leak internal state (no stack traces, no field names, no collection names)
- MongoDB error codes handled via enum: `MongoError.DuplicateKey`, `MongoError.WriteConflict`
- Validation errors formatted through `formatError()` utility
- Non-HTTP exceptions caught by `UnhandledExceptionsInterceptor` and wrapped as 500

### Event/Messaging Rules
- Use NestJS `EventEmitter2` for async decoupled operations (notifications, analytics)
- WebSocket gateways organized by namespace
- Active streams tracked with `Map<clientId, Map<streamId, AbortController>>`
- Always cancel active streams on client disconnect
- Always use `WsJwtGuard` on gateways

### Logging Rules
- Structured JSON logging
- Every request logged with: method, path, status, latency, user context
- Severity: ERROR for 5xx, WARNING for 401/403, INFO for everything else
- Include distributed trace context from `x-cloud-trace-context` header
- Never log sensitive data (passwords, tokens, full request bodies)

---

## Frontend Standards (React + MUI)

### API Layer Rules
- Every API module must define `const BASE` for endpoint prefixing
- API functions are async, destructure `{ data }` from axios responses
- Auth endpoints only in central `axios.ts` — all others in domain modules
- `HttpError.message` is debug-only (formatted as `[status] route: message`) — NEVER display to users
- Use `error.userMessage` when you need the backend's original error text
- Date strings from API must be transformed to Date objects via `transformDateFields()`

### React Query Rules
- All query keys must come from enums in `src/types/query-keys.ts` — never inline string keys
- Query keys are arrays: `[EnumKey, ...params]`
- No retry on 4xx client errors — only retry 5xx server errors
- Mutations must invalidate related queries in `onSuccess`
- Show feedback via `enqueueSnackbar` in `onSuccess`/`onError` with i18n keys
- Use `useInfiniteQuery` for cursor-based pagination, regular `useQuery` for offset-based
- Disable refetch flags (`refetchOnWindowFocus`, etc.) for real-time data managed by WebSocket

### State Management Rules
- Server state: React Query (never local state for API data)
- Form state: React Hook Form with Yup validation
- Toggle state: `useBoolean()` hook — never raw `useState(false)`
- Debounced inputs: `useDebounce()` hook
- Persistent state: `useLocalStorage()` hook
- Pagination state: `useServerPagination()` hook

### Component Rules
- View files use `-view.tsx` suffix
- Test locators declared at file root: `const locators = testLocators.feature.sub;` — always named `locators`
- All component props extend `TestableComponentProps` from `@shared/constants/locators`
- Use `VoidFunction` type for no-argument callback props — never `() => void`
- Conditional rendering: `condition ? <Component /> : null` — never `condition && <Component />`
- Arrays/objects containing JSX must be wrapped in `useMemo` with proper deps
- Keep components small — single responsibility, split when they grow
- Feature flags gate unreleased features: `isFeatureEnabled(Feature.X)` — never expose mock data to production

### Styling Rules
- **Only MUI components** — no raw HTML tags
- **Only `sx` prop** — never inline `style` attribute
- **Only theme values** — never hardcoded colors, spacing, shadows, or transitions
- Colors: `theme.palette.*` with `alpha()` for transparency
- Spacing single values: numbers directly (`p: 2` = 16px)
- Spacing multiple values: `theme.spacing(a, b)`
- Transitions: `theme.transitions.create()`
- Shadows: `theme.shadows[n]`
- Border radius: number values (`borderRadius: 2`)
- Width/height: `1` = 100%, numbers = pixels
- Icons: Iconify with string identifiers only — never import MUI icons or icon objects
- CSS selectors: use MUI class objects (`outlinedInputClasses`) — never hardcoded class strings

### i18n & RTL Rules
- All user-facing text must use `t()` from `useTranslate()` — never hardcoded strings
- Use CSS logical properties (`paddingInlineStart`, `marginInlineEnd`) — never `left`/`right` for directional spacing
- When logical properties aren't possible, check `theme.direction === 'rtl'` and swap
- Date formatting must use locale-aware `fDateLocale()` with `currentLang.dateFnsLocale`

### Routing Rules
- Routes organized by role in separate files
- Guard stack on routes: `AuthGuard` → `RoleBasedGuard` → Layout → `Suspense` → `Outlet`
- All route components lazy-loaded with `React.lazy()` + `<Suspense fallback={<LoadingScreen />}>`
- Feature flags can gate entire routes by setting empty `roles` array
- Inner page navigation (tabs within pages) uses `useInnerPage()` hook
- Resource selection in URLs uses `useInnerPageParam()` hook with context provider

### Authentication Rules
- JWT stored in HTTP-only cookie — never accessible to JavaScript
- Token expiration tracked via response header, with client-side timer for auto-redirect
- Logout must go through server endpoint (to clear cookie) — never just clear client state
- URL token delegation (`?token=...`) must be cleaned from URL after use
- Every login/logout tracked in analytics

---

## Testing Standards

### E2E Testing (Playwright)
- No unit tests — all testing is E2E via Playwright
- Page Object Model for UI abstractions
- Fixtures for reusable test setup (auth, pages, seed data)
- API helpers for direct data setup — don't click through UI to create test data
- Test locators from `@shared/constants/locators` — never use CSS selectors or text matching
- 3-shard parallel execution in CI
- Trace, screenshot, video captured on failure only

### Test Locator Rules
- All locator strings are kebab-case and descriptive
- Locators organized hierarchically by feature in nested objects
- Dynamic locators use postfix pattern: `base-string-` + dynamic value
- Every interactive element must have a `data-testid` from locators
- Component-level locators via `testId` prop from `TestableComponentProps`
- Internal element locators via `const locators` object at file root

### Mocking Rules
- External services mocked via custom axios adapter pattern — never mock internal services
- Mock routes defined as typed arrays with path matching
- Mock errors use `MockHttpError` class with proper status codes

---

## Git & Workflow Standards

### Branching
- Feature branches: `TICKET-XXXX` or `TICKET-XXXX-descriptive-name`
- PRs always target `dev` — never direct to `main`
- `main` is production — merges trigger deployment

### Commits
- Conventional commits: `type(scope): description (TICKET-XXXX)`
- Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `deploy`, `perf`
- Scopes: `frontend`, `backend`, or module-specific

### CI/CD
- Path-filtered — skip builds when irrelevant files change
- Parallel: frontend build, backend build, lint checks
- E2E: parallel Playwright shards with blob report merging
- Flaky test detection and reporting

### Error Checking Before Commit
- Type-check specific changed files: `npx tsc-files --noEmit "path"`
- Lint specific changed files: `npx eslint "path"`
- Config file changes require full-project lint/type-check
- Always run IDE diagnostics before considering work complete
