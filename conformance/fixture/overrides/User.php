<?php

namespace App\Models;

use Illuminate\Contracts\Auth\MustVerifyEmail;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Lukk\Concerns\HasRefreshTokens;
use Lukk\Concerns\HasTwoFactorAuthentication;

// Implements MustVerifyEmail so the email-verification matrix combo works. The
// verification methods come from the framework trait already used by the base
// Authenticatable — enabling verification is just implementing the contract.
class User extends Authenticatable implements MustVerifyEmail
{
    use HasRefreshTokens;
    use HasTwoFactorAuthentication;
    use Notifiable;

    protected $fillable = ['name', 'email', 'password'];

    protected $hidden = ['password', 'remember_token', 'two_factor_secret', 'two_factor_recovery_codes'];

    protected function casts(): array
    {
        return ['password' => 'hashed', 'email_verified_at' => 'datetime'];
    }
}
