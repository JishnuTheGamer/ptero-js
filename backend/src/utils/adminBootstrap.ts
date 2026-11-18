import crypto from 'node:crypto';

export interface InitialAdminCredentials {
    email: string;
    username: string;
    password: string;
    generatedPassword: boolean;
}

export function resolveInitialAdminCredentials(
    env: Record<string, string | undefined> = process.env
): InitialAdminCredentials {
    const email = (env.ADMIN_EMAIL || '').trim() || 'admin@ptero.local';
    const rawUser = (env.ADMIN_USERNAME || '').trim().toLowerCase();
    const username = rawUser || 'admin';
    const explicitPassword = (env.ADMIN_PASSWORD || '').trim();

    if (explicitPassword.length > 0) {
        return {
            email,
            username,
            password: explicitPassword,
            generatedPassword: false,
        };
    }

    return {
        email,
        username,
        password: crypto.randomBytes(9).toString('base64url'),
        generatedPassword: true,
    };
}
