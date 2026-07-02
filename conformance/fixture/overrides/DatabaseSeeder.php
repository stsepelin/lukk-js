<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        // A plain, verified user — `password` login returns a token pair.
        User::create([
            'name' => 'Test User',
            'email' => 'user@example.com',
            'password' => Hash::make('password'),
            'email_verified_at' => now(),
        ]);

        // A confirmed-2FA user — `password` login returns a two_factor challenge.
        $twoFactor = User::create([
            'name' => 'Two Factor User',
            'email' => '2fa@example.com',
            'password' => Hash::make('password'),
            'email_verified_at' => now(),
        ]);
        $twoFactor->forceFill([
            'two_factor_secret' => Crypt::encryptString('JBSWY3DPEHPK3PXP'),
            'two_factor_confirmed_at' => now(),
        ])->save();

        // An UNVERIFIED user — drives the email-verification flow (resend → click link
        // → verified). Kept separate so the other flows always start from a clean,
        // verified account regardless of whether the email feature is on.
        User::create([
            'name' => 'Unverified User',
            'email' => 'unverified@example.com',
            'password' => Hash::make('password'),
            'email_verified_at' => null,
        ]);
    }
}
