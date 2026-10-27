import { CanActivate, Controller, ExecutionContext, Injectable, Post, Body, BadRequestException, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface Auth { userId: string; deviceId: string }

export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-secret';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET is required in production');

/** Current user + device, set by AuthGuard. */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): Auth => ctx.switchToHttp().getRequest().auth);

/**
 * Token comes from `Authorization: Bearer` or `?token=` (EventSource cannot set headers),
 * device from `X-Device-Id` or `?device=`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const bearer = req.headers.authorization as string | undefined;
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : req.query.token;
    const deviceId = req.headers['x-device-id'] ?? req.query.device;
    if (!token || !deviceId) throw new UnauthorizedException('token and device id required');
    try {
      req.auth = { userId: (await this.jwt.verifyAsync(token)).sub, deviceId } satisfies Auth;
    } catch {
      throw new UnauthorizedException('invalid token');
    }
    return true;
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly jwt: JwtService) {}

  // shortcut: anyone can mint a token for any userId (no password), replace with real login before exposing this.
  @Post('token')
  async token(@Body() body: { userId?: string }) {
    if (!body?.userId) throw new BadRequestException('userId required');
    return { token: await this.jwt.signAsync({ sub: body.userId }) };
  }
}
