using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AuditEntries",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    EntityType = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    EntityId = table.Column<Guid>(type: "uuid", nullable: false),
                    Action = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    ActorUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    At = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    Before = table.Column<string>(type: "jsonb", nullable: true),
                    After = table.Column<string>(type: "jsonb", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AuditEntries", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "IdempotencyRecords",
                columns: table => new
                {
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Key = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    RequestHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    Status = table.Column<string>(type: "character varying(12)", maxLength: 12, nullable: false),
                    StatusCode = table.Column<int>(type: "integer", nullable: true),
                    ResponseBody = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IdempotencyRecords", x => new { x.UserId, x.Key });
                });

            migrationBuilder.CreateTable(
                name: "Users",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    KeycloakSub = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Email = table.Column<string>(type: "character varying(320)", maxLength: 320, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Users", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Groups",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(60)", maxLength: 60, nullable: false),
                    BaseCurrency = table.Column<string>(type: "character(3)", fixedLength: true, maxLength: 3, nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Groups", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Groups_Users_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Expenses",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    Description = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Category = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Currency = table.Column<string>(type: "character(3)", fixedLength: true, maxLength: 3, nullable: false),
                    AmountMinor = table.Column<long>(type: "bigint", nullable: false),
                    OccurredOn = table.Column<DateOnly>(type: "date", nullable: false),
                    SplitMethod = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Expenses", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Expenses_Groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "Groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Members",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    DisplayName = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    PaymentDetails = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    JoinedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Members", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Members_Groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "Groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Members_Users_UserId",
                        column: x => x.UserId,
                        principalTable: "Users",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ExpensePayers",
                columns: table => new
                {
                    MemberId = table.Column<Guid>(type: "uuid", nullable: false),
                    ExpenseId = table.Column<Guid>(type: "uuid", nullable: false),
                    AmountMinor = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExpensePayers", x => new { x.ExpenseId, x.MemberId });
                    table.ForeignKey(
                        name: "FK_ExpensePayers_Expenses_ExpenseId",
                        column: x => x.ExpenseId,
                        principalTable: "Expenses",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ExpensePayers_Members_MemberId",
                        column: x => x.MemberId,
                        principalTable: "Members",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ExpenseShares",
                columns: table => new
                {
                    MemberId = table.Column<Guid>(type: "uuid", nullable: false),
                    ExpenseId = table.Column<Guid>(type: "uuid", nullable: false),
                    AmountMinor = table.Column<long>(type: "bigint", nullable: false),
                    InputValue = table.Column<long>(type: "bigint", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExpenseShares", x => new { x.ExpenseId, x.MemberId });
                    table.ForeignKey(
                        name: "FK_ExpenseShares_Expenses_ExpenseId",
                        column: x => x.ExpenseId,
                        principalTable: "Expenses",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ExpenseShares_Members_MemberId",
                        column: x => x.MemberId,
                        principalTable: "Members",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Invites",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    Token = table.Column<string>(type: "character varying(43)", maxLength: 43, nullable: false),
                    MemberId = table.Column<Guid>(type: "uuid", nullable: true),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UsedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    UsedByUserId = table.Column<Guid>(type: "uuid", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Invites", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Invites_Groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "Groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Invites_Members_MemberId",
                        column: x => x.MemberId,
                        principalTable: "Members",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Settlements",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    GroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    FromMemberId = table.Column<Guid>(type: "uuid", nullable: false),
                    ToMemberId = table.Column<Guid>(type: "uuid", nullable: false),
                    Currency = table.Column<string>(type: "character(3)", fixedLength: true, maxLength: 3, nullable: false),
                    AmountMinor = table.Column<long>(type: "bigint", nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    DeletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Settlements", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Settlements_Groups_GroupId",
                        column: x => x.GroupId,
                        principalTable: "Groups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Settlements_Members_FromMemberId",
                        column: x => x.FromMemberId,
                        principalTable: "Members",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Settlements_Members_ToMemberId",
                        column: x => x.ToMemberId,
                        principalTable: "Members",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AuditEntries_GroupId_At",
                table: "AuditEntries",
                columns: new[] { "GroupId", "At" });

            migrationBuilder.CreateIndex(
                name: "IX_ExpensePayers_MemberId",
                table: "ExpensePayers",
                column: "MemberId");

            migrationBuilder.CreateIndex(
                name: "IX_Expenses_GroupId_OccurredOn_CreatedAt_Id",
                table: "Expenses",
                columns: new[] { "GroupId", "OccurredOn", "CreatedAt", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_ExpenseShares_MemberId",
                table: "ExpenseShares",
                column: "MemberId");

            migrationBuilder.CreateIndex(
                name: "IX_Groups_CreatedByUserId",
                table: "Groups",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_IdempotencyRecords_CreatedAt",
                table: "IdempotencyRecords",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_Invites_GroupId",
                table: "Invites",
                column: "GroupId");

            migrationBuilder.CreateIndex(
                name: "IX_Invites_MemberId",
                table: "Invites",
                column: "MemberId");

            migrationBuilder.CreateIndex(
                name: "IX_Invites_Token",
                table: "Invites",
                column: "Token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Members_GroupId_UserId",
                table: "Members",
                columns: new[] { "GroupId", "UserId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Members_UserId",
                table: "Members",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_Settlements_FromMemberId",
                table: "Settlements",
                column: "FromMemberId");

            migrationBuilder.CreateIndex(
                name: "IX_Settlements_GroupId",
                table: "Settlements",
                column: "GroupId");

            migrationBuilder.CreateIndex(
                name: "IX_Settlements_ToMemberId",
                table: "Settlements",
                column: "ToMemberId");

            migrationBuilder.CreateIndex(
                name: "IX_Users_KeycloakSub",
                table: "Users",
                column: "KeycloakSub",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AuditEntries");

            migrationBuilder.DropTable(
                name: "ExpensePayers");

            migrationBuilder.DropTable(
                name: "ExpenseShares");

            migrationBuilder.DropTable(
                name: "IdempotencyRecords");

            migrationBuilder.DropTable(
                name: "Invites");

            migrationBuilder.DropTable(
                name: "Settlements");

            migrationBuilder.DropTable(
                name: "Expenses");

            migrationBuilder.DropTable(
                name: "Members");

            migrationBuilder.DropTable(
                name: "Groups");

            migrationBuilder.DropTable(
                name: "Users");
        }
    }
}
