import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Response } from 'express';
import type { AuthTokens, AuthUser } from '@gsi/shared-types';
import { CurrentUser, Public } from '../common/decorators';
import { config } from '../config';
import type { RequestWithContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';

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

function ctxOf(req: RequestWithContext) {
  return { ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.requestId };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle(SIGN_IN_LIMIT)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: RequestWithContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokens> {
    const session = await this.auth.login(dto.email, dto.password, ctxOf(req));
    setRefreshCookie(res, session.refreshToken, session.refreshTtlSeconds);
    return { accessToken: session.accessToken, user: session.user };
  }

  @Public()
  @Throttle(SIGN_IN_LIMIT)
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response): Promise<AuthTokens> {
    const rawToken = readRefreshCookie(req);
    if (!rawToken) throw new UnauthorizedException('Missing refresh token');
    try {
      const session = await this.auth.refresh(rawToken, ctxOf(req));
      setRefreshCookie(res, session.refreshToken, session.refreshTtlSeconds);
      return { accessToken: session.accessToken, user: session.user };
    } catch (err) {
      // A denied refresh always leaves the browser without a usable cookie: retrying the same
      // one — expired, revoked, or a stolen copy replayed after rotation — cannot fool a later
      // call into looking like a fresh sign-in.
      clearRefreshCookie(res);
      throw err;
    }
  }

  /** Ends this one session. Works even without a valid access token: signing out should not
   *  require the very thing it is discarding. */
  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response): Promise<{ success: true }> {
    const rawToken = readRefreshCookie(req);
    if (rawToken) await this.auth.logout(rawToken, ctxOf(req));
    clearRefreshCookie(res);
    return { success: true };
  }

  /** Ends every session of the signed-in user — "log out everywhere". */
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Req() req: RequestWithContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ revoked: number }> {
    const revoked = await this.auth.logoutAll(user.id, 'user_logout_all', ctxOf(req));
    clearRefreshCookie(res);
    return { revoked };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
