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
        // A plain user — `password` login returns a token pair.
        User::create([
            'name' => 'Test User',
            'email' => 'user@example.com',
            'password' => Hash::make('password'),
        ]);

        // A confirmed-2FA user — `password` login returns a two_factor challenge.
        $twoFactor = User::create([
            'name' => 'Two Factor User',
            'email' => '2fa@example.com',
            'password' => Hash::make('password'),
        ]);
        $twoFactor->forceFill([
            'two_factor_secret' => Crypt::encryptString('JBSWY3DPEHPK3PXP'),
            'two_factor_confirmed_at' => now(),
        ])->save();
    }
}
