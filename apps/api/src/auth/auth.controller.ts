import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { AuthUser } from '@gsi/shared-types';
import { CurrentUser, Public } from '../common/decorators';
import { config } from '../config';
import type { RequestWithContext } from '../common/request-context';
import { AuthService } from './auth.service';

/**
 * Sign-in has a much smaller budget than the rest of the API: it is the one endpoint where
 * an attacker gains something by calling it thousands of times.
 */
const SIGN_IN_LIMIT = {
  default: { limit: config.rateLimit.authLimit, ttl: config.rateLimit.windowSeconds * 1000 },
};

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}

class RefreshDto {
  @IsString()
  refreshToken: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(SIGN_IN_LIMIT)
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: RequestWithContext) {
    return this.auth.login(dto.email, dto.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.requestId,
    });
  }

  @Public()
  @Throttle(SIGN_IN_LIMIT)
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
