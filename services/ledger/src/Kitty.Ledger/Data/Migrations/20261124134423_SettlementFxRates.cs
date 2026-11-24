using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Kitty.Ledger.Data.Migrations
{
    /// <inheritdoc />
    public partial class SettlementFxRates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "ConvertedAmountMinor",
                table: "Settlements",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<decimal>(
                name: "FxRate",
                table: "Settlements",
                type: "numeric(20,10)",
                precision: 20,
                scale: 10,
                nullable: true);

            migrationBuilder.AddColumn<DateOnly>(
                name: "FxRateDate",
                table: "Settlements",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "FxRateSource",
                table: "Settlements",
                type: "character varying(6)",
                maxLength: 6,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "PaidInGroupCurrency",
                table: "Settlements",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ConvertedAmountMinor",
                table: "Settlements");

            migrationBuilder.DropColumn(
                name: "FxRate",
                table: "Settlements");

            migrationBuilder.DropColumn(
                name: "FxRateDate",
                table: "Settlements");

            migrationBuilder.DropColumn(
                name: "FxRateSource",
                table: "Settlements");

            migrationBuilder.DropColumn(
                name: "PaidInGroupCurrency",
                table: "Settlements");
        }
    }
}
