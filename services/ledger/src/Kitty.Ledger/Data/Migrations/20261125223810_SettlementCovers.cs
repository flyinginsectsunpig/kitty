using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class SettlementCovers : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SettlementCovers",
                columns: table => new
                {
                    ExpenseId = table.Column<Guid>(type: "uuid", nullable: false),
                    SettlementId = table.Column<Guid>(type: "uuid", nullable: false),
                    AmountMinor = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SettlementCovers", x => new { x.SettlementId, x.ExpenseId });
                    table.ForeignKey(
                        name: "FK_SettlementCovers_Expenses_ExpenseId",
                        column: x => x.ExpenseId,
                        principalTable: "Expenses",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_SettlementCovers_Settlements_SettlementId",
                        column: x => x.SettlementId,
                        principalTable: "Settlements",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SettlementCovers_ExpenseId",
                table: "SettlementCovers",
                column: "ExpenseId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SettlementCovers");
        }
    }
}
