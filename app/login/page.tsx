import Link from "next/link";

import LoginAutoClear from "./_components/LoginAutoClear";

type SearchParams = {
  error?: string | string[];
  next?: string | string[];
};

function first(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] ?? "";
  return param ?? "";
}

function safeNextPath(raw: string): string {
  if (!raw) return "";
  if (!raw.startsWith("/")) return "";
  if (raw.startsWith("//")) return "";
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const sp = await Promise.resolve(searchParams ?? {});

  const errorParam = first(sp.error);
  const next = safeNextPath(first(sp.next));

  const error = (() => {
    if (!errorParam) return null;
    if (errorParam === "invalid") return "Usuario o contraseña incorrectos";
    if (errorParam === "server") return "Error del servidor. Intenta de nuevo.";
    return "No se pudo iniciar sesión";
  })();

  return (
    <div className="caliche-shell min-h-screen bg-background text-foreground">
      <LoginAutoClear />
      <div className="caliche-container mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-10 sm:py-14">
        <header>
          <h1 className="caliche-title text-3xl tracking-tight">Sign in</h1>
          <p className="caliche-subtitle mt-2 text-sm">
            Use your username and password.
          </p>
        </header>

        {error ? (
          <div className="caliche-alert rounded-2xl px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}

        <form
          method="post"
          action="/api/auth/login-form"
          className="caliche-panel rounded-3xl p-5 sm:p-6"
        >
          <div className="flex flex-col gap-4">
            {next ? <input type="hidden" name="next" value={next} /> : null}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
                Username
              </span>
              <input
                name="username"
                autoComplete="username"
                required
                className="caliche-input h-11 rounded-xl px-4 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
                Password
              </span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="caliche-input h-11 rounded-xl px-4 text-sm"
              />
            </label>

            <button
              type="submit"
              className="caliche-primary-btn h-11 rounded-full px-4 text-sm font-medium"
            >
              Sign in
            </button>

            <p className="text-sm text-foreground/70">
              No account?{" "}
              <Link href="/register" className="font-medium hover:underline">
                Create one
              </Link>
              .
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
