import Link from "next/link";

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
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-sm text-foreground/70">
            Use your username and password.
          </p>
        </header>

        {error ? (
          <div className="rounded-2xl border border-foreground/15 bg-foreground/5 px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}

        <form
          method="post"
          action="/api/auth/login-form"
          className="rounded-3xl border border-foreground/15 bg-background p-5"
        >
          <div className="flex flex-col gap-4">
            {next ? <input type="hidden" name="next" value={next} /> : null}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-foreground/70">Username</span>
              <input
                name="username"
                autoComplete="username"
                required
                className="h-11 rounded-xl border border-foreground/15 bg-background px-4 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-foreground/70">Password</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="h-11 rounded-xl border border-foreground/15 bg-background px-4 text-sm"
              />
            </label>

            <button
              type="submit"
              className="h-11 rounded-full bg-foreground px-4 text-sm font-medium text-background hover:opacity-90"
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
