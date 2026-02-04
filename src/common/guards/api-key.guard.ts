import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Verificar si el endpoint es público
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const apiKey = this.extractApiKeyFromHeader(request);

    if (!apiKey) {
      throw new UnauthorizedException('API Key es requerida');
    }

    if (!this.validateApiKey(apiKey)) {
      throw new UnauthorizedException('API Key inválida');
    }

    return true;
  }

  private extractApiKeyFromHeader(request: any): string | undefined {
    // Buscar API Key en el header 'X-API-Key' o 'Authorization'
    const apiKeyFromCustomHeader = request.headers['x-api-key'];
    const authHeader = request.headers['authorization'];

    if (apiKeyFromCustomHeader) {
      return apiKeyFromCustomHeader;
    }

    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return undefined;
  }

  private validateApiKey(apiKey: string): boolean {
    const validApiKeys = process.env.API_KEYS?.split(',').map(key => key.trim()) || [];
    return validApiKeys.includes(apiKey);
  }
}
