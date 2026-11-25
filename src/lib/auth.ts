import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { getToken } from 'next-auth/jwt';
import { db } from '@/lib/db';
import { allowAccountAttempt, normalizeEmail, verifyPassword } from '@/lib/account-security';

export async function authenticatePassword(email: string, password: string) {
  const normalized = normalizeEmail(email);
  if (!await allowAccountAttempt('login', normalized)) return null;
  if (password.length > 1024 || normalized.length > 254) return null;
  const user = await db.accountUser.findUnique({ where: { email: normalized } });
  const valid = await verifyPassword(password, user?.passwordHash ?? null);
  if (!valid || !user?.emailVerified) return null;
  return { id: user.id, email: user.email, name: user.name };
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? [GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      checks: ['pkce', 'state'],
    })] : []),
    CredentialsProvider({
      name: 'Email and password',
      credentials: { email: { label: 'Email', type: 'email' }, password: { label: 'Password', type: 'password' } },
      async authorize(credentials) {
        if (!process.env.NEXTAUTH_SECRET || typeof credentials?.email !== 'string' || typeof credentials.password !== 'string' || !credentials.email || !credentials.password) return null;
        return authenticatePassword(credentials.email, credentials.password);
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!process.env.NEXTAUTH_SECRET) return false;
      if (account?.provider !== 'google') return account?.provider === 'credentials';
      const google = profile as { email_verified?: boolean; sub?: string; email?: string } | undefined;
      if (google?.email_verified !== true || !google.sub || !google.email) return false;
      const email = normalizeEmail(google.email);
      try {
        const identity = await db.accountIdentity.findUnique({ where: { provider_providerAccountId: { provider: 'google', providerAccountId: google.sub } }, include: { user: true } });
        if (identity) {
          if (!identity.user.emailVerified) return false;
          user.id = identity.userId;
          return true;
        }
        // Never silently link by email (including pre-registered credentials).
        if (await db.accountUser.findUnique({ where: { email } })) return false;
        const created = await db.accountUser.create({ data: {
          email, name: user.name, emailVerified: new Date(),
          identities: { create: { provider: 'google', providerAccountId: google.sub } },
        } });
        user.id = created.id;
        return true;
      } catch { return false; }
    },
    async jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) Object.assign(session.user, { id: token.sub });
      return session;
    },
  },
};

export async function accountUserId(req: Request): Promise<string | null> {
  if (!process.env.NEXTAUTH_SECRET) return null;
  const token = await getToken({ req: req as Parameters<typeof getToken>[0]['req'], secret: process.env.NEXTAUTH_SECRET });
  if (!token?.sub) return null;
  const user = await db.accountUser.findUnique({ where: { id: token.sub }, select: { id: true, emailVerified: true } });
  return user?.emailVerified ? user.id : null;
}