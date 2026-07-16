import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ContactService } from './contact.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('contacts')
@UseGuards(JwtAuthGuard)
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Get()
  list(
    @CurrentUser('tenantId') tenantId: string,
    @Query('search') search?: string,
  ) {
    return this.contactService.list(tenantId, search);
  }
}
