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

export default async function RegisterPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams> | SearchParams;
}) {
  const sp = await Promise.resolve(searchParams ?? {});

  const errorParam = first(sp.error);
  const next = safeNextPath(first(sp.next));

  const error = (() => {
    if (!errorParam) return null;
    if (errorParam === "exists") return "Username already exists";
    if (errorParam === "server") return "Error del servidor. Intenta de nuevo.";
    // Validation strings are returned as-is.
    return errorParam;
  })();

  return (
    <div className="caliche-shell min-h-screen bg-background text-foreground">
      <div className="caliche-container mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-10 sm:py-14">
        <header>
          <h1 className="caliche-title text-3xl tracking-tight">Create account</h1>
          <p className="caliche-subtitle mt-2 text-sm">
            Choose a username and password.
          </p>
        </header>

        {error ? (
          <div className="caliche-alert rounded-2xl px-4 py-3 text-sm">
            {error}
          </div>
        ) : null}

        <form
          method="post"
          action="/api/auth/register-form"
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
              <span className="text-[11px] text-foreground/60">
                3–32 chars. Letters, numbers, spaces, _ and -
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
                Password
              </span>
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                className="caliche-input h-11 rounded-xl px-4 text-sm"
              />
              <span className="text-[11px] text-foreground/60">Minimum 8 characters</span>
            </label>

            <button
              type="submit"
              className="caliche-primary-btn h-11 rounded-full px-4 text-sm font-medium"
            >
              Create account
            </button>

            <p className="text-sm text-foreground/70">
              Already have an account?{" "}
              <Link href="/login" className="font-medium hover:underline">
                Sign in
              </Link>
              .
            </p>
          </div>
        </form>
      </div>
    </div>
  );
}
