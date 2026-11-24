using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class ExpenseRecurringPeriod : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "RecurringPeriod",
                table: "Expenses",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<Guid>(
                name: "RecurringScheduleId",
                table: "Expenses",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Expenses_RecurringScheduleId_RecurringPeriod",
                table: "Expenses",
                columns: new[] { "RecurringScheduleId", "RecurringPeriod" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Expenses_RecurringScheduleId_RecurringPeriod",
                table: "Expenses");

            migrationBuilder.DropColumn(
                name: "RecurringPeriod",
                table: "Expenses");

            migrationBuilder.DropColumn(
                name: "RecurringScheduleId",
                table: "Expenses");
        }
    }
}
